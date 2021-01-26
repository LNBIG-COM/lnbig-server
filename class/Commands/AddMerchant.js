/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const CaptchaCommands = require('../CaptchaCommands')
const debug = require('debug')('lnbig:commands:addMerchant')
const billingNode = require('../../global/billingNode')
const openChannelService = require('../../global/openChannelService')
const {newCapacity} = require('../../lib/utilChannels')
const APIDataCache = require('../APIDataCache')
const nodeStorage = require('../../global/nodeStorage')
let _ = require('lodash');
const pTimeout = require('p-timeout')
const OPEN_CHANNEL_TIMEOUT = 3000

class AddMerchantError extends Error {
    constructor (error, thank = false) {
        super(error)
        this.thank = thank
    }

    async claim(controller) {
        if (this.thank)
            return await controller.createClaim(1, 'Thanks and sorry! ;-)') // 1 satoshi
        else
            return null
    }
}

class DescribeGraphCache extends APIDataCache {
    constructor(storage) {
        super('GraphCache', () => billingNode.client.describeGraph({}), 5 * 60 * 1000, storage )
    }
}

module.exports = class AddMerchant extends CaptchaCommands {
    constructor() {
        debug('AddMerchant constructor started')
        super()
        this.namespace = 'addMerchant'; // Same namespace in client side
        this.dgCache = new DescribeGraphCache(billingNode.storage)
    }

    get captchaName () { return 'addMerchant' }

    async onCloseSocket() {
        super.onCloseSocket();
    }

    async cmdCheckInvoiceData(message) {
        try {
            if (! this.reCaptchaV3 && ! this.reCaptchaV2)
                throw new AddMerchantError('The reCaptcha was not resolved')
            let nodeID = await this.parseInvoice(message.invoice)
            let node = await this.foundNodeInGraph(nodeID)
            if (! node)
                throw new AddMerchantError(`This node (${nodeID}) doesn't exist in network graph. May be it's private node?`)
            let addresses = node.addresses.filter((v) => v.network === 'tcp' && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(v.addr))
            if (addresses.length === 0)
                throw new AddMerchantError(`The node ${nodeID} doesn't have an IPv4 address - we cannot connect to it! Sorry!`, true)
            this.sendCommand(message, 'cmdCheckInvoiceResult', { result: 'OK', message: `We are opening the channel to node ${nodeID}@${addresses[0].addr}`})
            try {
                let res = await this.openChannelWithNode(nodeID, addresses[0].addr)
                if (res) {
                    // Всё успешно - выслать lnurl-withdraw
                    this.sendCommand(message, 'cmdOpenChannelResult', {result: 'OK', message: 'We opened the channel thanks to you! Claim your 1000 sats!', claim: await this.createClaim(1000, 'Thank you for helping!') })
                }
            }
            catch (e) {
                switch (e.constructor) {
                    case AddMerchantError:
                        debug("Ошибка открытия канала: %s", e.message)
                        this.sendCommand(message, 'cmdOpenChannelResult', {result: 'FAIL', reason: e.message, claim: await e.claim(this) })
                        break
                    default:
                        this.sendCommand(message, 'cmdOpenChannelResult', {result: 'FAIL', reason: 'Internal error'})
                        console.error('Непонятная ошибка открытия канала: %s', e.message)
                }
            }
        }
        catch(e) {
            switch (e.constructor) {
                case AddMerchantError:
                    debug("cmdCheckInvoiceData: ошибка для клиента: %s", e.message)
                    this.sendCommand(message, 'cmdCheckInvoiceResult', {result: 'FAIL', reason: e.message, claim: await e.claim(this) })
                    break
                default:
                    this.sendCommand(message, 'cmdCheckInvoiceResult', {result: 'FAIL', reason: 'Internal error'})
                    console.error('Ошибка cmdCheckInvoiceData: %s', e.message)
            }
        }

    }

    async parseInvoice(invoice) {
        invoice = invoice.toLowerCase()
        let res

        if ((res = /^lightning:(.*)$/.exec(invoice)))
            invoice = res[1]
        if ((res = /^(lnbc[a-z0-9]+)$/.exec(invoice)) === null)
            throw new AddMerchantError('The invoice is not correct')

        invoice = res[1]
        debug("Получен инвойс: %s", invoice)

        if (! billingNode.client)
            throw new AddMerchantError('We have trouble with billing node')

        res = await billingNode.client.decodePayReq({pay_req: invoice})
        debug("Инвойс после декодирования: %o", res)

        if (+res.timestamp + +res.expiry < Date.now() / 1000)
            throw new AddMerchantError('The invoice was expired')

        if (! res.destination || res.destination === '')
            throw new AddMerchantError('Cannot find remote node id')

        if (! /^[0-9a-f]{66}$/i.test(res.destination))
            throw new AddMerchantError('Node ID is not correct')

        // TODBG
        if (await this.foundActiveChannelsWithNode(res.destination))
            throw new AddMerchantError(`We already have channels with node ${res.destination}`, true)

        if (await this.foundPendingChannelsWithNode(res.destination))
            throw new AddMerchantError(`We don't have channels with node ${res.destination} but have pending ones. Try later again!`, true)
        return res.destination
    }

    async foundActiveChannelsWithNode(nodeID) {
        let lc = await openChannelService.lcCache.data()

        if (newCapacity(nodeID, lc) !== 0)
            return true
    }

    async foundPendingChannelsWithNode(nodeID) {
        let pn = await openChannelService.pnCache.data()

        if (pn[nodeID])
            return true
    }

    async foundNodeInGraph(nodeID) {
        let graph = await this.dgCache.data()
        let res = graph.nodes.filter((v) => v.pub_key === nodeID)
        if (res.length > 0) {
            console.assert(res.length === 1, "foundNodeInGraph: Такого не может быть, %s", nodeID)
            return res[0]
        }
        return null
    }

    async openChannelWithNode(nodeID, address) {
        let wb = await openChannelService.wbCache.data()
        let maxTries = 3

        for (let key of _.shuffle(Object.keys(wb)).filter( v => +wb[v].total_balance >= 10E6 + 20000)) {
            debug("Пробуем открыть канал на узле %s (total_balance=%d)", key, +wb[key].total_balance)
            let node = nodeStorage.nodes[key]
            if (node.client) {
                let connected = false
                try {
                    debug("Коннект на ноду (%s@%s) от %s нашего узла для открытия канала",nodeID, address, node.key)
                    let res = await node.client.connectPeer({addr: {pubkey: nodeID, host: address}, perm: false})
                    debug("Результат коннекта канала на %s@%s: %o", nodeID, address, res)
                    connected = true
                }
                catch (e) {
                    if (/already connected to peer/.test(e.message))
                        connected = true
                    else {
                        if (/connection timed out/.test(e.message))
                            throw new AddMerchantError(`Connected timed out to node ${nodeID}@${address}`)
                        if (/connection refused/.test(e.message))
                            throw new AddMerchantError(`Connection was refused to node ${nodeID}@${address}`)
                        if (/no route to host/.test(e.message))
                            throw new AddMerchantError(`No route to node ${nodeID}@${address}`)
                        console.log(`openChannelWithNode: непонятная ошибка коннекта: %s`. e.message)
                        throw new AddMerchantError(`Unknown error of connect to node ${nodeID}@${address}`)
                    }
                }
                if (connected) {
                    try {
                        let res = await pTimeout(
                            node.client.openChannelSync({
                                node_pubkey_string: nodeID,
                                local_funding_amount: 10E6,
                                push_sat: 0,
                                target_conf: 6,
                                private: false,
                                min_htlc_msat: 1,
                                min_confs: 0,
                                spend_unconfirmed: true
                            }),
                            OPEN_CHANNEL_TIMEOUT
                        )
                        debug('Результат открытия канала на узел %s@%s: %o', nodeID, address, res)
                        return res
                    }
                    catch (e) {
                        debug("Ошибка открытия канала %s@%s: %s", nodeID, address, e.message)
                        if (--maxTries <= 0)
                            throw new AddMerchantError(`We tried to open channel (to ${nodeID}@${address}) several times but all attempts failed`)
                    }
                }
            }
        }
        return null
    }

    async createClaim(amntSats, reason) {
        let obj = await billingNode.createClaimRequest(amntSats, reason)

        return obj.lnurl
    }
}
