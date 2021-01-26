/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const crypto = require('crypto');
const lnd = require('lnd-async');
const debug = require('debug')('lnbig:BillingNode')
const storage = require('node-persist')
const uuidv4 = require('uuid/v4')
const bech32 = require('bech32');

function tolerantFeeSasts(paymentAmount) {
    let fee = Math.round(paymentAmount * 0.01)
    return fee < 20 ? 20 : fee
}

class BillingNode {
    constructor() {
        this.client = null
        this.macaroon = process.env.BILLING_NODE_MACAROON
        this.host = process.env.BILLING_NODE_HOST

        this.storage = storage.create({
            dir: `${process.env.BASE_STORAGE_DIR}/billing-node`,
            ttl: false
        });
        this.storagePromise = this.storage.init()
    }

    async init(password) {
        this.password = password
        this.decrypt()
        await this.storagePromise
    }

    async connect(connectOpts = {}) {
        let connect = lnd.connect(Object.assign({
            lndHost: this.host,
            lndPort: 10009,
            cert: process.env.BILLING_NODE_CERT,
            macaroon: this.macaroon,
            longsAsNumbers: false
        }, connectOpts))
            .then(client => {
                debug(`Создан gRPC stub (${this.host})`);
                this.client = client
                return client
            })
            .then( client => client.getInfo({}))
            .catch(e => {
                this.client = null;
                debug(`Ошибка (${e.message}) создания gRPC stub (${this.host}) - временно отключаем`)
            });

        await connect
        debug(`Billing node ${this.client ? 'Connected' : 'Not connected'}`)
    }

    decrypt() {
        this.macaroon = this.decryptToBase64(this.macaroon)
        this.erasePassword();
    }

    erasePassword() {
        process.env.CRYPT_PASSWORD = this.password = crypto.randomBytes(32).toString('base64');
    }

    decryptToBase64(encrypted) {
        let input = Buffer.from(encrypted, 'base64');

        let salt = input.slice(8, 16);
        let key = crypto.pbkdf2Sync(this.password, salt, 10000, 48, 'sha256');
        let iv = key.slice(32);
        key = key.slice(0, 32);

        let dec = crypto.createDecipheriv('aes-256-cbc', key, iv);
        return Buffer.concat([dec.update(input.slice(16)), dec.final()]).toString('base64');
    }

    async createClaimRequest(amntSats, reason) {
        // Формирует уникальный UUID, но балансы нод пока не опрашивает
        let uuid = uuidv4()
        let time = new Date()

        let lnurlObj = {
            callback: `${process.env.BASE_API_URL}/lnurl-withdraw`,
            k1: uuid,
            maxWithdrawable: amntSats * 1000,
            defaultDescription: reason,
            tag: "withdrawRequest"
        }

        let obj = {
            amntSats,
            reason,
            uuid,
            lnurlObj,
            lnurl: this.getLnurlWithdraw(uuid),
            createDateISO: time.toISOString(),
            createDateHuman: time.toString(),
            createDateMilliseconds: time.getTime(),
            redeemed: false,
            pending: false,
            claimInvoice: null
        }

        await this.storage.setItem(`claim-${uuid}`, obj, {ttl: false })
        return obj
    }

    getLnurlWithdraw(uuid) {
        let url = `${process.env.BASE_API_URL}/lnurl-withdraw?stage=1&k1=${uuid}`
        debug("getLnurlWithdraw: url is %s", url)
        return bech32.encode('lnurl', bech32.toWords(Buffer.from(url, 'utf8')), 1024)
    }

    async findClaimRequest(uuid, cb = null) {
        // uuid должен быть валидным - проверять до обращения!
        let key = `claim-${uuid}`
        let obj = await this.storage.getItem(key)
        if (! obj)
            return null
        debug("Claim запрос найден: uuid: %s, obj: %o", uuid, obj)
        if (cb && await cb(obj)) {
            await this.storage.setItem(key, obj)
            debug("Claim объект сохранён после изменений: uuid: %s, obj: %o", uuid, obj)
        }
        return obj
    }

    async checkAndPayInvoiceForClaim(uuid, invoice) {
        // Проверяем claim, инвойс, и если всё успешно - оплачиваем
        debug("Поступил запрос на оплату: uuid: %s, invoice: %s", uuid, invoice)
        let obj = await this.findClaimRequest(uuid, (obj) => {
            if (obj.redeemed)
                throw new Error('The claim is already redeemed!')
            if (obj.pending)
                throw new Error('The claim is already pending...')
            obj.pending = true
            obj.claimInvoice = invoice
            return 1
        })
        if (obj) {
            try {
                if (this.client) {
                    let data = await this.client.decodePayReq({pay_req: invoice})
                    debug("Сервер оплаты: декодированный инвойс: %o", data)
                    if (+data.num_satoshis > obj.amntSats)
                        throw new Error('You want to claim more than should be there - failed!')
                    let res;
                    try {
                        debug("Послан запрос на оплату, data: %o", data)
                        /*res = await this.client.sendPaymentSync({
                            dest_string: data.destination,
                            payment_hash_string: data.payment_hash,
                            fee_limit: {fixed: tolerantFeeSasts(obj.amntSats)},
                            amt: obj.amntSats
                        })*/
                        res = await this.client.sendPaymentSync({
                            payment_request: invoice,
                            fee_limit: {fixed: tolerantFeeSasts(obj.amntSats)},
                        })
                        debug("Судя по всему - успешно оплачен, res: %o", res)
                    }
                    catch(e) {
                        throw new Error('We cannot to pay to you (big fees/route problems and etc. Try later!)')
                    }
                    if (res.payment_error) {
                        throw new Error(`Error from server: ${res.payment_error}`)
                    }
                    debug("Выплата состоялась: obj: %o, req: %o, res: %o", obj, data, res)
                    await this.findClaimRequest(uuid, obj => {obj.redeemed = true; return 1})
                }
                else {
                    throw new Error('We have trouble with billing node')
                }
            }
            catch(e) {
                debug("Выплата не состоялась - ошибка: %s", e.message)
                throw e
            }
            finally {
                await this.findClaimRequest(uuid, obj => {
                    obj.pending = false
                    return 1
                })
            }
        }
    }
}

module.exports = BillingNode
