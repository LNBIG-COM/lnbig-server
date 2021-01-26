/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

/*
* Модуль подсчёта newCapacity для ноды
*
* */
const debug = require('debug')('lnbig:util-channels')

const BitcoinClient = require('bitcoin-core')
const bitcoinClient = new BitcoinClient({
    username: process.env.BITCOIND_USER,
    password: process.env.BITCOIND_PASS,
    host: process.env.BITCOIND_HOST || 'localhost'
})

module.exports.newCapacity = function (nodeID, listChannels) {
    let newCapacity = 0

    for (let key in listChannels) {
        for (let channel of listChannels[key].channels) {
            if (channel.remote_pubkey === nodeID) {
                newCapacity += ( +channel.capacity / 2 - +channel.local_balance ) * 2
                debug("newCapacity (%s) текущее: %d (key: %s, %o)", nodeID, newCapacity, key, channel)
            }
        }
    }
    debug("Для узла %s получили newCapacity: %d", nodeID, newCapacity)
    return newCapacity
}

module.exports.utilityOfNode = function (nodeID, listChannels) {
    let utility = {
        amntChannels: 0,
        newCapacity: 0,
        totalSent: 0,
        sentPerBlock: 0,
        pendingHTLC: 0,
        privateAmnt: 0,
        nonPrivateAmnt: 0,
        weAreInitiator: 0,
    }

    for (let key in listChannels) {
        for (let channel of listChannels[key].channels) {
            if (channel.remote_pubkey === nodeID) {
                // let tx = getTx()
                utility.amntChannels++
                utility.newCapacity  += ( +channel.capacity / 2 - +channel.local_balance ) * 2
                utility.totalSent    += +channel.total_satoshis_sent
                utility.sentPerBlock += +channel.total_satoshis_sent /
                debug("utilityOfNode/newCapacity (%s) текущее: %d (key: %s, %o)", nodeID, utility.newCapacity, key, channel)
            }
        }
    }
    debug("Для узла %s получили newCapacity: %d", nodeID, utility.newCapacity)
    return utility
}

module.exports.checkPendingNodes = async function (pendingChannels) {
    let channel, pendingBalancesByNodeId = {}, badPendingChannels = [], waitClosePendingChannels = []

    for (let key in pendingChannels) {
        let pc = pendingChannels[key]

        for (channel of pc.pending_open_channels) {
            debug("channel/pending_open_channels %o", channel)
            let {hash, index} = splitChannelPoint(channel.channel.channel_point)
            if (await checkTx(hash, index)) {
                if (+channel.channel.local_balance > 0) {
                    pendingBalancesByNodeId[channel.channel.remote_node_pub] = pendingBalancesByNodeId[channel.channel.remote_node_pub] || {}
                    pendingBalancesByNodeId[channel.channel.remote_node_pub][key] = Math.max(pendingBalancesByNodeId[channel.channel.remote_node_pub][key] || 0, +channel.channel.local_balance)
                }
            }
            else {
                badPendingChannels.push({hash, index, key, type: 'pending_open_channels'})
            }
        }

        for (channel of pc.pending_closing_channels) {
            debug("channel/pending_closing_channels %o", channel)
            let {hash, index} = splitChannelPoint(channel.channel.channel_point)
            if (await checkTx(hash, index)) {
                if (+channel.channel.local_balance > 0) {
                    pendingBalancesByNodeId[channel.channel.remote_node_pub] = pendingBalancesByNodeId[channel.channel.remote_node_pub] || {}
                    pendingBalancesByNodeId[channel.channel.remote_node_pub][key] = Math.max(pendingBalancesByNodeId[channel.channel.remote_node_pub][key] || 0, +channel.channel.local_balance)
                }
            }
            else {
                badPendingChannels.push({hash, index, key, type: 'pending_closing_channels'})
            }
        }

        for (channel of pc.pending_force_closing_channels) {
            debug("channel/pending_force_closing_channels %o", channel)
            let {hash, index} = splitChannelPoint(channel.channel.channel_point)
            if (await checkTx(hash, index)) {
                if (+channel.channel.local_balance > 0) {
                    pendingBalancesByNodeId[channel.channel.remote_node_pub] = pendingBalancesByNodeId[channel.channel.remote_node_pub] || {}
                    pendingBalancesByNodeId[channel.channel.remote_node_pub][key] = Math.max(pendingBalancesByNodeId[channel.channel.remote_node_pub][key] || 0, +channel.channel.local_balance)
                }
            }
            else {
                badPendingChannels.push({hash, index, key, type: 'pending_force_closing_channels'})
            }
        }

        for (channel of pc.waiting_close_channels) {
            debug("channel/waiting_close_channels %o", channel)
            let {hash, index} = splitChannelPoint(channel.channel.channel_point)
            if (await checkTx(hash, index)) {
                if (+channel.channel.local_balance > 0) {
                    pendingBalancesByNodeId[channel.channel.remote_node_pub] = pendingBalancesByNodeId[channel.channel.remote_node_pub] || {}
                    pendingBalancesByNodeId[channel.channel.remote_node_pub][key] = Math.max(pendingBalancesByNodeId[channel.channel.remote_node_pub][key] || 0, +channel.channel.local_balance)
                }
                waitClosePendingChannels.push({hash, index, key, type: 'waiting_close_channels'})
            }
            else {
                badPendingChannels.push({hash, index, key, type: 'waiting_close_channels'})
            }
        }
    }

    return {pendingBalancesByNodeId, badPendingChannels, waitClosePendingChannels}
}

module.exports.currentBlockchainBlock = function (getInfo) {
    let currentBlock = 0

    for (let key in getInfo) {
        currentBlock = Math.max(currentBlock, Number(getInfo[key].block_height))
    }

    return currentBlock
}

let checkTx = module.exports.checkTx = async function(hash, index) {
    debug("Проверяем транзакцию: %s / %d", hash, index)
    try {
        let res = await bitcoinClient.getRawTransaction(hash, true)
        debug("Результат проверки: %o", res)
        if (! res.vout[+index] )
            console.error("Нет индекса!, %o", res)
        return ! ! (res && res.vout[+index])
    }
    catch(e) {
        if (e.code !== -5)
            console.error("Ошибка RPC (%s:%d): %s, %o", hash, index, typeof e, e)
        return false
    }
}

module.exports.getTx = async function(hash) {
    debug("Получаем транзакцию: %s", hash)
    try {
        let res = await bitcoinClient.getRawTransaction(hash, true)
        debug("Получена транзакция: %o", res)
        return res
    }
    catch(e) {
        console.error("Ошибка RPC: %s, %o", typeof e, e)
        return null
    }
}

let splitChannelPoint = module.exports.splitChannelPoint  = function (channelPoint) {
    let parts = /^(.*):(\d+)$/.exec(channelPoint)
    if (! parts)
        throw new Error(`channelPoint (${channelPoint}) parts are not defined`)
    let res = { hash: parts[1], index: +parts[2] }
    debug("splitChannelPoint: %o", res)
    return res
}
