/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const PromisePool = require('es6-promise-pool')
const util = require('util');
const nodeStorage = require('../global/nodeStorage');
const {Mutex} = require('await-semaphore')

const debug = require('debug')('rebalance')
const debugPay = debug.extend('pay')

const { myNodes } = require('../global/myNodes')
const {
    MIN_LOCAL_PART,
    MAX_LOCAL_PART,
    MINIMUM_FOR_BALANCE,
} = require('./constants')
const _ = require('lodash')
const pTimeout = require('p-timeout')
const fs = require('fs')
const fsOpen = util.promisify(fs.open)
const fsWriteFile = util.promisify(fs.writeFile)
const fsClose = util.promisify(fs.close)

const listChannels = require('../lib/listChannels')
const getInfo  = require('../lib/getInfo')

const AMOUNT_ROUNDS = 5
const ROUND_FACTOR  = 1.5

const SEND_PAYMENT_OK           = 1
const SEND_PAYMENT_AGAIN        = 2
const SEND_PAYMENT_STOP         = 3
const SEND_PAYMENT_STOP_TIMEOUT = 4
const SEND_PAYMENT_NO_ROUTE     = 5

// По 4 платежа в потоке
const SEND_PAYMENT_CONCURRENCY  = 4

const INVOICE_CLTV       = 10
const SEND_TIMEOUT       = 20000 /* milliseconds*/

const TYPE_RECEIVER = 1
const TYPE_SENDER   = 2

// Баним узел, если это или более количества фейлов
const BAN_NODE_AFTER_N_FAILS = 3

// Баним локальный канал, если столько неудачных SEND_PAYMENT_NO_ROUTE ошибок
const BAN_LOCAL_CHAN_ID_AFTER_N_FAILS = 3

//const waitNextTick = util.promisify(setImmediate)
const waitSomeTime = util.promisify(setTimeout)

/*
* Используется для всех типов каналов - наших и чужих
* */
class Edge {
    constructor ({chanId, capacity = 0, grpcClient = null}) {
        this.chanId = chanId
        this.capacity = +capacity
        this.grpcClient = grpcClient
        this.node1Pubkey = this.node2Pubkey = null
        this.node1Policy = this.node2Policy = null
        this.isPolicy = false
        this.guessedBalance = null // Баланс на стороне node1Pubkey. На node2Pubkey будет обратная величина
        this.guessedBalanceMutex = new Mutex()
    }

    async changeBalance(cb) {
        let release
        try {
            release = await this.guessedBalanceMutex.acquire()
            await cb()
        }
        finally {
            release()
        }
    }

    async policies() {
        if (! this.grpcClient)
            throw new Error('Edge::policies - не определён grpcClient')
        let res = await this.grpcClient.getChanInfo({chan_id: this.chanId})
        this.node1Pubkey = res.node1_pub
        this.node2Pubkey = res.node2_pub
        this.node1Policy = res.node1_policy
        this.node2Policy = res.node2_policy
        this.capacity    = +res.capacity

        await this.changeBalance(() => {
            if (! this.guessedBalance)
                this.guessedBalance = [0, this.capacity] // [ min, max ]
        })

        this.isPolicy = true
    }

    policy(pubKey) {
        if (this.node1Pubkey === pubKey)
            return this.node1Policy
        else if (this.node2Pubkey === pubKey)
            return this.node2Policy
        else
            throw new Error(`Edge::policy - такого не должено быть! (${pubKey}) - ${util.inspect(this)}`)
    }

    async guessPaymentTo({pubKey, amountSats, ok = true, pathTitle, error}) {
        let reverse = this.node1Pubkey === pubKey
        // В норме считаем, что reverse === true, если from > to (другими словами - from === node2Pubkey, to === node1Pubkey )

        debug("guessPaymentTo (%s)/%s, before: %s, %d, ok=%o, guessedBalance: %o", pathTitle, this.chanId, pubKey, amountSats, ok, this.guessedBalance)
        await this.changeBalance(() => {
            if (ok) {
                // Если платёж проходит
                if (error) {
                    // Если он мог бы пройти, но событие не состоялось
                    if (! reverse) {
                        this.guessedBalance[0] = Math.max(this.guessedBalance[0], amountSats)
                        this.guessedBalance[1] = Math.max(this.guessedBalance[1], amountSats)
                    }
                    else {
                        this.guessedBalance[0] = this.capacity - Math.max(this.capacity - this.guessedBalance[0], amountSats)
                        this.guessedBalance[1] = this.capacity - Math.max(this.capacity - this.guessedBalance[1], amountSats)
                    }
                }
                else {
                    // Платёж был и событие состоялось
                    if (! reverse) {
                        this.guessedBalance[1] -= amountSats
                        this.guessedBalance[0] = Math.max(this.guessedBalance[0] - amountSats, 0)
                    }
                    else {
                        this.guessedBalance[0] += amountSats
                        this.guessedBalance[1] = Math.min(this.guessedBalance[1] + amountSats, this.capacity)
                    }
                }
            }
            else {
                // Если не проходит
                if (! reverse) {
                    this.guessedBalance[1] = Math.min(this.guessedBalance[1], amountSats - 1)
                }
                else {
                    this.guessedBalance[0] = Math.max(this.guessedBalance[0], this.capacity - amountSats + 1)
                }
            }
        })
        debug("guessPaymentTo (%s)/%s, after: %s, %d, ok=%o, guessedBalance: %o", pathTitle, this.chanId, pubKey, amountSats, ok, this.guessedBalance)
    }

    get node1PubkeyBin() {
        return Buffer.from(this.node1Pubkey, 'hex')
    }

    get node2PubkeyBin() {
        return Buffer.from(this.node2Pubkey, 'hex')
    }
}

/*
* Используется только для внутренних каналов
* */
class LocalEdge extends Edge {
    constructor (key, channel) {
        super({chanId: channel.chan_id, capacity: channel.capacity, grpcClient: nodeStorage.nodes[key].client})

        this.channel = channel
        this.key = key
        this.localPubkey  = nodeStorage.nodes[key].pubKey
        this.remotePubkey = channel.remote_pubkey
        this.commitFee = +channel.commit_fee
        this.cleanCapacity = this.capacity - this.commitFee

        this.localBalance = +this.channel.local_balance
        this.target = { min: Math.round(this.cleanCapacity * MIN_LOCAL_PART), max: Math.round(this.cleanCapacity * MAX_LOCAL_PART) }
        this.type = this.localBalance < this.target.min ? TYPE_RECEIVER : TYPE_SENDER

        this.minReceive = this.target.min   - this.localBalance
        this.maxReceive = this.target.max   - this.localBalance
        this.minSend    = this.localBalance - this.target.max
        this.maxSend    = this.localBalance - this.target.min

        /* Канал считается разбалансированным, когда границы localBalance значительно выходят за пределы сбалансированного канала
        * (чтобы понапрасну не гонять туда сюда средства между каналами "на грани") */
        this.unbalanced
            =  this.localBalance < (this.cleanCapacity * MIN_LOCAL_PART * 0.5)
            || this.localBalance > (this.cleanCapacity * (MAX_LOCAL_PART / 2 + 1 / 2) )

        this.localPolicy = this.remotePolicy = null
    }

    async policies() {
        await super.policies()
        if (this.node1Pubkey === this.channel.remote_pubkey) {
            this.localPolicy  = this.node2Policy
            this.remotePolicy = this.node1Policy
        }
        else {
            this.localPolicy  = this.node1Policy
            this.remotePolicy = this.node2Policy
        }
    }

    get localPubkeyBin() {
        return Buffer.from(this.localPubkey, 'hex')
    }

    get remotePubkeyBin() {
        return Buffer.from(this.remotePubkey, 'hex')
    }
}

class EdgeStorage {
    constructor () {
        this.storage = {} //  ключи - chan_id, значение - объект Edge
        this.getMutex = new Mutex()
    }

    async get (chanId, grpcClient) {
        let release

        try {
            release = await this.getMutex.acquire()
            if (this.storage[chanId])
                return this.storage[chanId]
            await (this.storage[chanId] = new Edge({chanId, grpcClient})).policies()
            return this.storage[chanId]
        }
        finally {
            release()
        }
    }

    async printBalanceReport(fileName) {
        let nodes = {}

        for (let chanId in this.storage) {
            let edge = this.storage[chanId]
            if (! nodes[edge.node1Pubkey])
                nodes[edge.node1Pubkey] = { channels: {}, localCapacity: [0, 0], averageCapacity: 0 }
            if (! nodes[edge.node2Pubkey])
                nodes[edge.node2Pubkey] = { channels: {}, localCapacity: [0, 0], averageCapacity: 0 }
            let node1, node2, gb1, gb2
            gb1 = (node1 = nodes[edge.node1Pubkey]).channels[chanId] = edge.guessedBalance
            node1.localCapacity[0] += gb1[0]
            node1.localCapacity[1] += gb1[1]
            node1.averageCapacity  += (gb1[0] + gb1[1]) / 2
            gb2 = (node2 = nodes[edge.node2Pubkey]).channels[chanId] = [edge.capacity - edge.guessedBalance[1], edge.capacity - edge.guessedBalance[0]]
            node2.localCapacity[0] += gb2[0]
            node2.localCapacity[1] += gb2[1]
            node2.averageCapacity  += (gb2[0] + gb2[1]) / 2
        }

        let fd = await fsOpen(fileName, 'w', 0o640)
        await fsWriteFile(fd, `Stats by nodes\n\n`)
        for (let pubKey of Object.keys(nodes).sort((a, b) => nodes[b].averageCapacity - nodes[a].averageCapacity)) {
            let node = nodes[pubKey]
            await fsWriteFile(fd, `${pubKey} (capacity from ${node.localCapacity[0]/1E8} to ${node.localCapacity[1]/1E8} BTC)\n`)
            for (let chanId in node.channels) {
                let channel = node.channels[chanId]
                await fsWriteFile(fd, `  ${chanId}: ${channel[0]} .. ${channel[1]} sats\n`)
            }
        }
        fsClose(fd)
    }
}

class Rebalancer {
    constructor (options) {
        this.options = this.constructorOptions = options

        this.permanentIgnoredNodes       = {}
        this.permanentIgnoredLocalChanId = {} // Если receiver или sender с chanId часто получают SEND_PAYMENT_NO_ROUTE, тогда они каждый могут попасть сюда
        this.permanentIgnoredEdges       = {} // Ключи - "chan_id-0/1" , где 0 - если from < to по ascii (lexicographic order) упорядочиванию node id

        this.okAmntPayments        = 0
        this.failedAmntPayments    = 0
        this.timedOutAmntPayments  = 0
        this.noRouteAmntPayments   = 0
        this.totalPaidFees         = 0

        this.amntRunCycle        = 0
        this.amntRebalanaceCycle = 0

        this.edgeStorage = new EdgeStorage()

        this.concurrency = this.options.concurrency
    }

    resetIgnores() {
        /*  Игнорируемые каналы, список которых определяется на основе неудачных платежей */
        debug('resetIgnores...')
        this.ignoredPendingChannels      = {}
        this.ignoredPendingChannelsLocks = {}

        this.ignoreNodes        = {}
        this.ignoredEdges       = {} // Ключи - "chan_id-0/1" , где 0 - если from < to по ascii (lexicographic order) упорядочиванию node id
        this.ignoredLocalChanId = {}
    }

    async addToIgnore(edge) {
        if (edge instanceof LocalEdge) {
            if (!this.localIgnoredEdges.has(edge))
                this.localIgnoredEdges.set(edge, [{from: edge.localPubkeyBin, to: edge.remotePubkeyBin}, {from: edge.remotePubkeyBin, to: edge.localPubkeyBin}])
        }
        else {
            /* В LND есть баг - есть pending каналы, которые удалённые узлы уже считают открытыми (channel point уже в блокчейн)
            * Но сам LND, который эти каналы открыл - считает их pending, пока его не перезапустишь
            * Но при этом запрос на поиск маршрута (QueryRoutes) включает эти каналы в маршруты, так как они есть в графе
            * Чтобы избавиться от таких казусов, приходится вести ещё этот список */
            if (! this.ignoredPendingChannels[edge.chanId] && ! this.ignoredPendingChannelsLocks[edge.chanId]) {
                this.ignoredPendingChannelsLocks[edge.chanId] = 1
                debug("ВНИМАНИЕ! Зависший pending канал (%s), который другими узлами транслируется в граф (lnd bug) - в игнор его!", edge.chanId)
                try {
                    await edge.policies()
                    let item = this.ignoredPendingChannels[edge.chanId] = [{from: edge.node1PubkeyBin, to: edge.node2PubkeyBin}, {from: edge.node2PubkeyBin, to: edge.node1PubkeyBin}]
                    debug("Pending канал (%s) добавлен в игнор как: %s", edge.chanId, util.inspect(item, false, 3))
                }
                finally {
                    this.ignoredPendingChannelsLocks[edge.chanId] = 0
                }
            }
        }
    }

    async readChannelInfo() {
        this.listChannels = listChannels(nodeStorage, {})
        this.getInfo = getInfo(nodeStorage)
        debug('Запускаются асинхронные команды...')
        this.listChannels = await this.listChannels
        this.getInfo = await this.getInfo
        debug('Данные получены полностью, обработка')

        this.localIgnoredEdges = new Map()
    }

    async run(options = this.constructorOptions) {
        // The number of promises to process simultaneously.
        this.options = options
        this.amntRunCycle++

        await this.readChannelInfo()
        await this.findCandidates()
        await this.rebalancing()
    }

    optimalAmount(receiver, sender, tolerance) {
        let min = Math.max(receiver.minReceive, sender.minSend)
        let max = Math.min(receiver.maxReceive, sender.maxSend)

        let res = null
        if (min < max)
            res = max
        else if (tolerance) {
            /* Если Rmax < Smin, но оба довольно большие - можно перекинуть Rmax
            *  Если Rmax > Smin, но оба довольно большие - можно перекинуть Smax */
            if (receiver.maxReceive < sender.minSend && sender.minSend / receiver.maxReceive <= tolerance)
                res = receiver.maxReceive
            else if (receiver.minReceive > sender.maxSend && receiver.minReceive / sender.maxSend <= tolerance)
                res = sender.maxSend
        }
        debug("Rmin=%d, Rmax=%d, Smin=%d, Smax=%d, optimalAmount=%d (tolerance=%d), receiver=%s, sender=%s", receiver.minReceive, receiver.maxReceive, sender.minSend, sender.maxSend, res, tolerance, receiver.chanId, sender.chanId)
        return res
    }

    /* factor теперь используется, если мы разбиваем платёж - тогда factor будет от 0 до 1 (например 1/4 при 4-х платежах)*/
    getMaxFeeMsats(amountSats, factor = 1) {
        return Math.floor(amountSats * 1000 * this.options.feeRate / 1E6 + this.options.feeBase * factor )
    }

    makeIgnoredNodes() {
        let list = Object.keys(
            Object.entries(this.ignoreNodes).reduce(
                (acc, val) => {
                    if (val[1] >= BAN_NODE_AFTER_N_FAILS)
                        acc[val[0]] = 1
                    return acc
                },
                {...this.permanentIgnoredNodes}
            )
        ).map( v => Buffer.from(v, 'hex'))
        debug("makeIgnoredNodes length now is %d", list.length)
        return list
    }

    mergeIgnoredNodesWithPermanentOnes() {
        debug("mergeIgnoredNodesWithPermanentOnes before, ignoreNodes=%o", this.ignoreNodes)
        Object.entries(this.ignoreNodes).forEach(
            (val) => {
                if (val[1] >= BAN_NODE_AFTER_N_FAILS)
                    this.permanentIgnoredNodes[val[0]] = 1
            }
        )
        debug("mergeIgnoredNodesWithPermanentOnes=%o", this.permanentIgnoredNodes)
    }

    mergeIgnoredLocalChanIdWithPermanentOnes() {
        debug("mergeIgnoredLocalChanIdWithPermanentOnes before, ignoredLocalChanId: %o", this.ignoredLocalChanId)
        Object.entries(this.ignoredLocalChanId).forEach(
            (val) => {
                if (val[1] >= BAN_LOCAL_CHAN_ID_AFTER_N_FAILS)
                    this.permanentIgnoredLocalChanId[val[0]] = 1
            }
        )
        debug("mergeIgnoredLocalChanIdWithPermanentOnes=%o", this.permanentIgnoredLocalChanId)
    }

    async findRoute(receiver, sender, {pathTitle, lastHopAmount, lastHopFeeMsat, maxFeeMsats, amount}) {
        if (this.options.dryRun)
            return null

        // Бывает, что в ходе отправок платежей предпоследний узел попадает в игнорируемые
        // (например он ушёл в оффлайн) - для такого перестаём искать маршруты
        if (this.permanentIgnoredNodes[receiver.remotePubkey])
            return null

        try {
            let req = {
                pub_key: receiver.channel.remote_pubkey, // Чтобы расчитать маршрут, используем конечный узел как предпоследний
                amt: lastHopAmount,
                final_cltv_delta: receiver.localPolicy.time_lock_delta + receiver.remotePolicy.time_lock_delta + 3, // +3 - это на всякий случай даю фору 2 блока...
                fee_limit: {fixed: Math.ceil((maxFeeMsats - lastHopFeeMsat) / 1000)},
                ignored_pairs: this.makeIgnoredPairs(receiver, sender),
                ignored_nodes: this.makeIgnoredNodes()
            }

            debug("Поиск маршрутов (%s) - делаем запрос, sats: %d", pathTitle, req.amt)
            //console.time('Поиск маршрутов')
            let res = await nodeStorage.nodes[sender.key].client.queryRoutes(req)
            //console.timeEnd('Поиск маршрутов')
            debug("Маршрут(ы) найден(ы) (%s) - %s", pathTitle, util.inspect(res,false,4))

            if (res.routes.length > 1)
                debug("Найдено несколько маршрутов (%s): res: %o", pathTitle, res)

            let route = res.routes[0]

            if (route.hops[0].chan_id !== sender.chanId) {
                console.warn(`Первый канал (${pathTitle}) (${route.hops[0].chan_id}) должен быть равен sender (${sender.chanId}) каналу! Пробуем снова!`)
                let edge = new Edge({chanId: route.hops[0].chan_id, grpcClient: sender.grpcClient})
                await this.addToIgnore(edge)
                return null
            }

            // https://github.com/lightningnetwork/lnd/issues/3712#issuecomment-553297703
            // Not more 20 hops
            if (route.hops.length > 19)
                return null

            route.hops.push({
                chan_id: receiver.chanId,
                chan_capacity: receiver.channel.capacity,
                amt_to_forward_msat: amount * 1000,
                fee_msat: 0,
                expiry: route.hops[route.hops.length - 1].expiry - receiver.remotePolicy.time_lock_delta,
                pub_key: receiver.localPubkey
            })

            await this.recalculateRoute(receiver, route, nodeStorage.nodes[sender.key].client)

            debug("Сравнение комиссий пересчитанного маршрута (%s) (%d) и допустимых (%d)", pathTitle, route.total_fees_msat, maxFeeMsats)
            if (route.total_fees_msat <= maxFeeMsats) {
                debugPay("Маршрут после изменения (%s): %s", pathTitle, util.inspect(route,false,4))
                return route
            }
            return null
        }
        catch (e) {
            debug("Поиск маршрутов (%s) - ошибка: %s", pathTitle, e.message)
            return null
        }
    }

    async createInvoice(receiver, sender, {route, pathTitle}) {
        let amountSats = Math.floor((+route.total_amt_msat - +route.total_fees_msat) / 1000)
        let memo = `Rebalance from ${sender.key} to ${receiver.key} ${amountSats} sats`
        debugPay("Создание инвойса - (%s): %s", pathTitle, memo)
        if (! this.options.dryRun) {
            let res = await receiver.grpcClient.addInvoice({
                memo,
                value: amountSats,
                expiry: Math.round((SEND_TIMEOUT / 1000) + this.options.attempts * 10),
                cltv_expiry: INVOICE_CLTV
            })
            let decodedPayReq = await sender.grpcClient.decodePayReq({pay_req: res.payment_request})
            debug("Декодированный инвойс: %o", decodedPayReq)
            return decodedPayReq
        }
        else {
            return null
        }
    }

    async considerChance(receiver, sender, amount) {
        // debug("Ставим pending блокировку, receiver: %s, sender: %s", receiver.chanId, sender.chanId)
        // Ставим pending блокировку, чтобы не обрабатывать их в другом потоке
        let opts

/*
        if (! (opts = this.getOptsForPartlyPayment({receiver, sender}, amount)).feeOK) {
            // TODBG - проверить потом - не должно исполняться
            debug(
                "ВНИМАНИЕ! Не должно произойти, так как проверка была ранее, но fee последнего хопа ( %d msats ) будет выше целевой (%d msats) - аннулируем балансировку (%s), amount: %d, remotePolicy=%o",
                opts.lastHopFeeMsat,
                opts.maxFeeMsats,
                opts.pathTitle,
                amount,
                receiver.remotePolicy
            )
            let release = await this.sendersMutex.acquire()
            this.senders.push(sender)
            release()
            return
        }
*/

        opts = this.getOptsForPartlyPayment({receiver, sender}, amount)
        debug("considerChance: пробуем отправить платежи (%s), opts: %o", opts.pathTitle, opts)
        let payments = await this.sendMultiPayment({receiver, sender, fullAmount: amount, opts})

        if (payments.filter(v => v.status === SEND_PAYMENT_OK).length > 0) {
            // Если платёж прошёл - теперь эти receiver & sender использоваться не будут
            debug("Платежи (%s) прошли частично: %o", opts.pathTitle, payments)
            if (this.startOutputDots)
                process.stdout.write('X')
            return true
        }
        else {
            // Неудачная балансировка - снова засовываем элементы в массивы для обработки
            let release

            debug("Балансировка не удалась (%s) - возвращаем sender обратно", opts.pathTitle)

            release = await this.sendersMutex.acquire()
            this.senders.push(sender)
            release()
            return false
        }
    }

    async sendMultiPayment(args) {
        let {fullAmount} = args
        let payments = []
        let id = 1, amount

        for (; fullAmount > 0; fullAmount -= this.options.maxBalancedPayment, id++) {
            amount = fullAmount > this.options.maxBalancedPayment ? this.options.maxBalancedPayment : fullAmount
            payments.push({id, amount, status: null})
        }

        await this.sendPaymentsInParallel(payments, args)

        return payments
    }

    async sendPaymentsInParallel(payments, args) {
        // Отправляем максимум по 4 платежа параллельно
        let pool = new PromisePool(this.sendOnePaymentGenerator(payments, args), SEND_PAYMENT_CONCURRENCY)

        pool.addEventListener('fulfilled', function () {
        })

        pool.addEventListener('rejected', function (event) {
            console.error('sendPaymentsInParallel: error: %o: ', event.data.error.message)
        })

        debugPay(`Отправка платежей (${payments.length}) в потоке (${args.opts.pathTitle})`)

        // Start the pool.
        await pool.start()

        debugPay(`Отправка платежей (${payments.length}) завершена (${args.opts.pathTitle})`)
        //console.log(`Поиск маршрутов завершён.\nУспешных платежей: ${this.okAmntPayments}\nНеуспешных платежей: ${this.failedAmntPayments}\nЗатрачено: ${Math.floor(this.totalPaidFees / 1000)} sats`)
    }

    * sendOnePaymentGenerator(payments, args) {
        for (let payment of payments) {
            let opts = this.getOptsForPartlyPayment(args, payment.amount, payment.id, payments.length)
            if (opts.feeOK) {
                yield ( async () => {
                    await waitSomeTime(Math.floor(Math.random() * 5000))
                    debug("Payment[%d] (%s), payment: %o, opts before: %o, opts after: %o", payment.id, args.opts.pathTitle, payment, args.opts, opts)
                    payment.status = await this.createInvoiceAndPay({...args, opts});

                    if (payment.status !== SEND_PAYMENT_OK) {
                        if (payment.status === SEND_PAYMENT_NO_ROUTE) {
                            debug("Не найдены маршруты (%s) для платежа [%d]", args.opts.pathTitle, payment.id)

                            this.ignoredLocalChanId[args.sender.chanId]   = (this.ignoredLocalChanId[args.sender.chanId] || 0) + 1
                            this.ignoredLocalChanId[args.receiver.chanId] = (this.ignoredLocalChanId[args.receiver.chanId] || 0) + 1

                            debug("ignoredLocalChanId: %o", this.ignoredLocalChanId)

                            this.noRouteAmntPayments++
                        }
                        else {
                            payment.status === SEND_PAYMENT_STOP_TIMEOUT ? this.timedOutAmntPayments++ : this.failedAmntPayments++
                        }
                    }
                })()
            }
        }
    }

    /*
    * Расчитывает комиссию последнего "хопа", максимальную комиссию на основе целевых параметров
    * и вычисляет сумму, которую надо будет выставить в инвойсе
    * Также определяет: является ли итоговая комиссия последнего хопа выше целевой
    * (позже расчёта маршрута будет вычислена новая комиссия, которая снова будет сверена с целевой - эта нужна,
    * чтобы сразу отсечь варианты, если последний хоп берёт больше, чем нам нужно)
    * */
    getOptsForPartlyPayment({receiver, sender}, amount, paymentNumber = 1, paymentsAmount = 1) {
        // Расчитываем fee для последнего канала
        let opts = {
            pathTitle: `${sender.key}->${sender.chanId}->${receiver.chanId}->${receiver.key} [${paymentNumber}/${paymentsAmount}]`,
            maxFeeMsats: this.getMaxFeeMsats(amount, 1 / paymentsAmount),
            lastHopFeeMsat: Math.floor(amount * 1000 * +receiver.remotePolicy.fee_rate_milli_msat / 1E6 + +receiver.remotePolicy.fee_base_msat),
            amount
        }
        opts.lastHopAmount = Math.floor(opts.lastHopFeeMsat / 1000 + amount)
        opts.feeOK = ! (opts.lastHopFeeMsat > opts.maxFeeMsats)

        return opts
    }

    feeNotExceed(receiver, factor = 1) {
        return +receiver.remotePolicy.fee_rate_milli_msat <= this.options.feeRate && +receiver.remotePolicy.fee_base_msat <= this.options.feeBase * factor
    }

    async createInvoiceAndPay({receiver, sender, opts }) {
        debug("createInvoiceAndPay, opts: %o", opts)
        let route = await this.findRoute(receiver, sender, opts)
        let status

        if (route) {
            let payReq = await this.createInvoice(receiver, sender, {route, pathTitle: opts.pathTitle})
            let i
            for (i = 0; i < this.options.attempts && route; i++) {
                // Делаем несколько попыток оплаты
                if ((status = await this.sendPayment(receiver, sender, {route, payReq, pathTitle: opts.pathTitle})) !== SEND_PAYMENT_AGAIN)
                    break
                route = await this.findRoute(receiver, sender, opts)
            }
        }

        return route ? status : SEND_PAYMENT_NO_ROUTE
    }

    async guessBalances({route, pathTitle, error = null, sender}) {
        // Расчёт балансов с учётом успешного прохождения платежа
        debug("guessBalances (%s), route: %o, error: %o", pathTitle, route, error)
        routeLoop: for (let i = 0; i < route.hops.length; i++) {
            let hop = route.hops[i]
            let edge = await this.edgeStorage.get(hop.chan_id, sender.grpcClient)
            debug("guessBalances (%s), edge: %o", pathTitle, edge)
            if (error) {
                switch (error.code) {
                    case 'TEMPORARY_CHANNEL_FAILURE':
                        if (error.failure_source_index === i) {
                            await edge.guessPaymentTo({pathTitle, pubKey: hop.pub_key, amountSats: Math.floor((+hop.amt_to_forward_msat + +hop.fee_msat) / 1000), ok: false, error})
                            break routeLoop
                        }
                        break
                    case 'UNKNOWN_NEXT_PEER':
                    case 'TEMPORARY_NODE_FAILURE':
                    case 'UNKNOWN_FAILURE':
                    case 'EXPIRY_TOO_FAR':
                    case 'PERMANENT_NODE_FAILURE':
                    case 'FEE_INSUFFICIENT':
                        if (error.failure_source_index === i)
                            break routeLoop
                        break
                }
            }
            // Мы тут, если данный канал надо обработать как пропускающий платёж
            debug("guessBalances (%s), p_1", pathTitle)

            // Пытаемся прикинуть баланс с учётом прохождения платежа (указываем только to узла, а from он вычислит сам)
            await edge.guessPaymentTo({pathTitle, pubKey: hop.pub_key, amountSats: Math.floor((+hop.amt_to_forward_msat + +hop.fee_msat) / 1000), error})
        }
        debug("guessBalances (%s), p_2", pathTitle)
    }

    async sendPayment(receiver, sender, {payReq, route, pathTitle}) {
        if (! this.options.dryRun) {
            try {
                let resPayment = await pTimeout(
                    sender.grpcClient.Router.sendToRoute({
                        payment_hash: Buffer.from(payReq.payment_hash, 'hex'),
                        route
                    }),
                    SEND_TIMEOUT
                )
                debugPay("Результат оплаты канала (%s): %o", pathTitle, resPayment)
                if (resPayment.failure) {
                    let error = resPayment.failure
                    debugPay("Ошибка оплаты (%s) инвойса (%s), хопов: %d, ошибка: %s", pathTitle, payReq.description, route.hops.length, error.code);
                    // Добавляем в игнор проблемную edge
                    let sourceFailurePubkey = error.failure_source_index ? route.hops[error.failure_source_index - 1].pub_key : sender.localPubkey
                    let nextFailurePubkey = route.hops[error.failure_source_index].pub_key
                    let chanId = route.hops[error.failure_source_index].chan_id
                    switch (error.code) {
                        case 'TEMPORARY_CHANNEL_FAILURE':
                            this.ignoredEdges[`${chanId}-${+(sourceFailurePubkey > nextFailurePubkey)}`] = [{from: Buffer.from(sourceFailurePubkey, 'hex'), to: Buffer.from(nextFailurePubkey, 'hex')}]
                            //this.ignoreNodes[sourceFailurePubkey] = (this.ignoreNodes[sourceFailurePubkey] || 0) + 1
                            debugPay("Добавляем в игнор (%s), %s, %s->%s, [%s]", pathTitle, chanId, sourceFailurePubkey, nextFailurePubkey, `${chanId}-${+(sourceFailurePubkey > nextFailurePubkey)}`)
                            await this.guessBalances({route, pathTitle, error, sender})
                            return SEND_PAYMENT_AGAIN
                        case 'UNKNOWN_NEXT_PEER':
                            this.permanentIgnoredNodes[nextFailurePubkey] = 1
                            await this.guessBalances({route, pathTitle, error, sender})
                            debugPay("Добавляем в игнор узел %s, так как он в оффлайн", nextFailurePubkey)
                            return SEND_PAYMENT_AGAIN
                        case 'TEMPORARY_NODE_FAILURE':
                        case 'UNKNOWN_FAILURE':
                        case 'EXPIRY_TOO_FAR':
                        case 'PERMANENT_NODE_FAILURE':
                            this.permanentIgnoredNodes[sourceFailurePubkey] = 1
                            debugPay("Добавляем в игнор узел %s, так как он временно не работает", sourceFailurePubkey)
                            await this.guessBalances({route, pathTitle, error, sender})
                            return SEND_PAYMENT_AGAIN
                        case 'FEE_INSUFFICIENT':
                            debugPay("Комиссии одного из узлов (%s) изменились, пробуем снова", sourceFailurePubkey)
                            // Перезапрашиваем policies - они должны были изменится в этот момент
                            await this.edgeStorage.get(chanId, sender.grpcClient).policies()
                            await this.guessBalances({route, pathTitle, error, sender})
                            //this.ignoreNodes[sourceFailurePubkey] = (this.ignoreNodes[sourceFailurePubkey] || 0) + 1
                            return SEND_PAYMENT_AGAIN
                        default:
                            debugPay("Неизвестная ошибка (%s), решить как её обрабатывать, error: %o", error.code, error)
                            return SEND_PAYMENT_STOP
                    }
                }
                else {
                    this.totalPaidFees += route.total_fees_msat
                    await this.guessBalances({route, pathTitle, sender})
                    debugPay("Инвойс (%s) успешно оплачен (fee: %d sats)! Хопов: %d (%s). Всего уже заплачено: %d sats", payReq.description, Math.floor(route.total_fees_msat / 1000), route.hops.length, pathTitle, Math.floor(this.totalPaidFees / 1000))
                    this.okAmntPayments++
                    return SEND_PAYMENT_OK
                }
            }
            catch (e) {
                debugPay("Оплата канала (%s) - таймаут. Оставляем всё как есть и продолжаем дальше (%s)", payReq.description, pathTitle)
                return SEND_PAYMENT_STOP_TIMEOUT
            }
        }
        else {
            debugPay("Эмуляция отправки (%s), receiver: %o, sender: %o, route: %o", pathTitle, receiver, sender, route)
            return SEND_PAYMENT_OK
        }
    }

    async recalculateRoute(receiver, route, grpcClient) {
        debug("Начата рекалькуляция маршрута, receiver=%o, route=%o", receiver, route)
        route.hops[route.hops.length - 2].expiry = route.hops[route.hops.length - 1].expiry
        let nextAmount = +route.hops[route.hops.length - 1].amt_to_forward_msat
        let totalFeeMsat = 0

        for (let i = route.hops.length - 2; i >= 0; i--) {
            delete route.hops[i].fee
            let policy

            if (route.hops.length - 2 === i) {
                policy = receiver.remotePolicy
            }
            else {
                let edgeNext = await this.edgeStorage.get(route.hops[i + 1].chan_id, grpcClient)
                policy = edgeNext.policy(route.hops[i].pub_key)
            }
            if (! policy)
                throw new Error(`Неизвестны policy для узла ${route.hops[i].pub_key} канала ${route.hops[i].chan_id}`)
            route.hops[i].fee_msat = Math.floor(nextAmount * +policy.fee_rate_milli_msat / 1000000 + +policy.fee_base_msat)
            totalFeeMsat += route.hops[i].fee_msat

            route.hops[i].amt_to_forward_msat = nextAmount
            delete route.hops[i].amt_to_forward

            nextAmount = nextAmount + route.hops[i].fee_msat
        }

        route.total_amt_msat  = nextAmount
        route.total_fees_msat = totalFeeMsat
        delete route.total_amt
        delete route.total_fees
        debug("Конец рекалькуляции маршрута, receiver=%o, route=%o", receiver, route)
    }

    makeIgnoredPairs(receiver, sender) {
        let ignore = []

        this.localIgnoredEdges.forEach((array, edge) => {
            if (edge !== receiver && edge !== sender)
                ignore.push(...array)
            else if (edge === receiver)
                ignore.push(array[0])
            else if (edge === sender)
                ignore.push(array[1])
        })

        Object.values(this.ignoredPendingChannels).forEach(array => ignore.push(...array))
        Object.values({...this.permanentIgnoredEdges, ...this.ignoredEdges}).forEach(array => ignore.push(...array))

        return ignore
    }

    mergeIgnoredEdgesWithPermanent() {
        debug("mergeIgnoredEdgesWithPermanent before: %o", this.ignoredEdges)
        Object.entries(this.ignoredEdges).forEach(v => this.permanentIgnoredEdges[v[0]] = v[1])
    }

    async findCandidates() {
        /* Эти пары нужны для того, чтобы не оптимизировать каналы, которые лучше не оптимизировать
           Например: наш узел A имеет с узлом B два канала - один sender, другой receiver
           Если сбалансировать оба канала, то с одной стороны это хорошо,
           но с другой снижает прохождение крупного платежа в одном направлении.
           Учитывая, что узлы могут отправлять платёж через другой канал для того же удалённого узла,
           лучше иметь два несбалансированных канала с обеих сторон, чем два сбалансированных.
           nodePairs как раз призвана найти такие каналы и убрать из кандидатов
        *  */
        this.candidates = []
        let nodePairs = {}

        let amntReceivers = 0, amntSenders = 0, amntDeletedReceiversOrSenders = 0
        for (let key in nodeStorage.nodes) {
            if (nodeStorage.nodes[key].client) {
                for (let channel of this.listChannels[key].channels) {
                    // Канал не с моим узлом...
                    let edge = new LocalEdge(key, channel)
                    //debug("edge объект: %o", edge)
                    if (! myNodes[channel.remote_pubkey] && ! edge.channel.private && edge.channel.active && edge.unbalanced) {
                        let nodePairKey = `${edge.localPubkey}-${edge.remotePubkey}`
                        if (! nodePairs[nodePairKey])
                            nodePairs[nodePairKey] = []
                        nodePairs[nodePairKey].push(edge)
                    }
                    await this.addToIgnore(edge)
                }
            }
            else {
                throw new Error('Все узлы должны работать!')
            }
        }

        for (let arr of Object.values(nodePairs)) {
            if (arr.length > 1) {
                // Определяем какие каналы убрать из кандидатов, сортируем в первую очередь по размерам балансов,
                // чтобы удалить потом в первую очередь крупные каналы
                let senders   = arr.filter( v => v.type == TYPE_SENDER).sort((a, b) => a.localBalance - b.localBalance)
                let receivers = arr.filter( v => v.type == TYPE_RECEIVER).sort((a, b) => b.localBalance - a.localBalance)
                let amnt = Math.min(receivers.length, senders.length)

                if (amnt > 0) {
                    receivers.splice(0, amnt)
                    senders.splice(0, amnt)
                    amntDeletedReceiversOrSenders += amnt * 2
                    arr = [...receivers, ...senders]
                }
            }
            for (let edge of arr) {
                await edge.policies()
                // Требует ребалансировки
                //debug("Помещаем edge в список кандидатов, edge: %o", edge)
                if (edge.localPolicy && edge.remotePolicy) {
                    edge.type === TYPE_SENDER ? amntSenders++ : amntReceivers++
                    this.candidates.push(edge)
                }
            }
        }
        console.log("Количество receivers: %d, senders: %d, удалённых receivers/senders: %d", amntReceivers, amntSenders, amntDeletedReceiversOrSenders)
    }

    isBannedLocalChanId(receivedOrSender) {
        return   (this.ignoredLocalChanId[receivedOrSender.chanId] && this.ignoredLocalChanId[receivedOrSender.chanId] >= BAN_LOCAL_CHAN_ID_AFTER_N_FAILS)
              || this.permanentIgnoredLocalChanId[receivedOrSender.chanId];

    }

    async considerChanceForReceiver(receiver, backArray, tolerance = 0) {
        let release, sender, amount

        if (! this.feeNotExceed(receiver)) {
            debug(
                "Fee последнего хопа превышает заданную fee: rate %d против %d, base %d против %d, receiver: %o",
                +receiver.remotePolicy.fee_rate_milli_msat,
                this.options.feeRate,
                +receiver.remotePolicy.fee_base_msat,
                this.options.feeBase,
                receiver
            )
            return
        }

        let tried = new Set()

        for (;;) {
            if (this.isBannedLocalChanId(receiver)) {
                backArray.push(receiver)
                if (this.startOutputDots)
                    process.stdout.write('_')
                break
            }
            if (this.startOutputDots)
                process.stdout.write('.')
            try {
                release = await this.sendersMutex.acquire()
                sender = null
                for (let i = 0; i < this.senders.length; i++) {
                    if (tried.has(this.senders[i]))
                        continue
                    tried.add(this.senders[i])
                    amount = this.optimalAmount(receiver, this.senders[i], tolerance)
                    if (! amount || amount < MINIMUM_FOR_BALANCE || this.isBannedLocalChanId(this.senders[i]))
                        continue
                    sender = this.senders.splice(i, 1)[0]
                    break
                }
            }
            finally {
                release()
            }

            if (sender) {
                if (await this.considerChance(receiver, sender, amount))
                    break
            }
            else {
                backArray.push(receiver)
                if (this.startOutputDots)
                    process.stdout.write('_')
                break
            }
        }
    }


    async rebalancing() {
        this.receivers = []
        this.senders   = []
        this.sendersMutex   = new Mutex()
        this.amntRebalanaceCycle = 0

        // Проходим по каналам и собираем информацию для корректировки
        for (let receiver of this.candidates) {
            // Проходим по кандидатам на поиск маршрутов от send to receive
            if (receiver.type === TYPE_RECEIVER) {
                if (receiver.maxReceive >= MINIMUM_FOR_BALANCE)
                    this.receivers.push(receiver)
            }
        }

        for (let sender of this.candidates) {
            if (sender.type === TYPE_SENDER) {
                if (sender.maxSend >= MINIMUM_FOR_BALANCE)
                    this.senders.push(sender)
            }
        }

/*
        // TODBG
        this.receivers = this.receivers.splice(0, 10)
        this.senders   = this.senders.splice(0, 10)
*/

        for (let i = this.options.startRound - 1; i < AMOUNT_ROUNDS; i++) {
            // Create a pool.
            this.amntRebalanaceCycle++
            let pool = new PromisePool(this.findingRoutesGenerator(i), this.concurrency)

            pool.addEventListener('rejected', function (event) {
                console.error('findingRoutesGenerator: ОШИБКА: error: %o: ', event.data.error.message)
            })

            console.log(`Запуск поиска маршрутов в параллель: ${this.concurrency}`)

            // Start the pool.
            let poolPromise = pool.start()

            // Wait for the pool to settle.
            await poolPromise
            console.log(`----------------------------------
Ребаланс (раунд) завершён
На данный момент с момента запуска:

Успешных платежей: ${this.okAmntPayments}
Неуспешных платежей: ${this.failedAmntPayments}
Затрачено: ${Math.floor(this.totalPaidFees / 1000)} sats
----------------------------------
`)
            await this.edgeStorage.printBalanceReport(`rebalance-report-${this.amntRunCycle}-${this.amntRebalanaceCycle}.txt`)
        }
        // После последнего цикла у нас остаётся список игнорируемых каналов и узлов, где не прошли даже малые платежи
        // Эти списки мы объединяем с перманентными (между всеми циклами),
        // чтобы при следующих ребалансингах этот список помогал нам быстрее обходить такие каналы стороной
        this.mergeIgnoredNodesWithPermanentOnes()
        this.mergeIgnoredLocalChanIdWithPermanentOnes()
        this.mergeIgnoredEdgesWithPermanent()
    }

    * findingRoutesGenerator(i) {
        let amntDone = 0, percent = 0, amntFull = this.receivers.length

        let tolerance = i ? ROUND_FACTOR ** i : 0

        this.resetIgnores()

        // Проходим по каналам и собираем информацию для корректировки
        console.log("Количество кандидатов this.receivers: %d, this.senders: %d", this.receivers.length, this.senders.length)

        let options = this.options = Object.assign({}, this.constructorOptions)

        /*

        let countdown = AMOUNT_ROUNDS - i - 1
        options.feeRate = Math.round(options.feeRate / ROUND_FACTOR ** countdown)
        options.feeBase = Math.round(options.feeBase / ROUND_FACTOR ** countdown)

         */

        options.maxBalancedPayment = Math.round(options.maxBalancedPayment / ROUND_FACTOR ** i)
        if (! options.maxBalancedPayment || options.maxBalancedPayment < MINIMUM_FOR_BALANCE / 2)
            options.maxBalancedPayment = MINIMUM_FOR_BALANCE / 2

        console.log("---------------------------\nРаунд # %d", i + 1)

        console.log("Опция --fee-rate: %d", options.feeRate)
        console.log("Опция --fee-base: %d", options.feeBase)
        console.log("Опция --concurrency: %d", options.concurrency)
        console.log("Опция --max-balanced-payment: %d", options.maxBalancedPayment)

        let receiver, backArray = []

        this.startOutputDots = false

        while ((receiver = this.receivers.shift())) {
            yield this.considerChanceForReceiver(receiver, backArray, tolerance)
            amntDone++
            if (amntDone / amntFull * 100 >= percent) {
                percent = Math.floor(amntDone / amntFull * 100)
                console.log(
                    "Сделано %d%% (%d), Fees: %d sats, Успешных: %d, Без маршрута: %d, Таймаут: %d, Неудачных: %d",
                    percent,
                    amntDone,
                    Math.floor(this.totalPaidFees / 1000),
                    this.okAmntPayments,
                    this.noRouteAmntPayments,
                    this.timedOutAmntPayments,
                    this.failedAmntPayments
                )
                percent++
            }
        }

        this.startOutputDots = true

        this.receivers = backArray
    }
}

module.exports = async function (opts = {}) {
    if (opts.attempts < 1)
        throw new Error('--attempts должна быть более ноля')

    let rebalancer = new Rebalancer(opts)

    for (let i = 1; i <= 5; i++) {
        console.log(`Запуск ${i}/5\n\n`)
        await rebalancer.run()
    }
}
