/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const debug = require('debug')('lnbig:open-channel-service')
const storage = require('node-persist');

const walletBalance = require('../lib/walletBalance')
const pendingChannels = require('../lib/pendingChannels')
const listChannels = require('../lib/listChannels')
const { newCapacity, checkPendingNodes } = require('../lib/utilChannels')
const APIDataCache = require('../class/APIDataCache')

const clientWebSockets = require('../global/clientWebSockets')
const uuidv4 = require('uuid/v4')
const nodeStorage = require('../global/nodeStorage')
var _ = require('lodash')
const pTimeout = require('p-timeout')

const OPEN_CHANNEL_TIMEOUT  = 5000
const MAX_CHANNEL_VALUE     = 2 ** 24 - 1
const BALANCE_VALUE_LOCK    = MAX_CHANNEL_VALUE
const GRATIS_VALUE          = 2000000
const VALUE_QUANTUM         = 1000

const { OPEN_CHANNEL_LOCK_TTL, OPEN_CHANNEL_LOCK_EXPIRES, RESERVE_OPEN_CHANNEL_SATOSHIES } = require('../conf/commonConst')
const OPEN_CHANNEL_LOCK_KEY = 'openChannelLocks'

class WalletBalanceCache extends APIDataCache {
    constructor(storage) {
        super('walletBalances', () => walletBalance(nodeStorage), 20 * 1000, storage )
    }
}

class PendingChannelsCache extends APIDataCache {
    constructor(storage) {
        super('pendingChannels', () => pendingChannels(nodeStorage), 5 * 60 * 1000, storage )
    }
}

class ListChannelsCache extends APIDataCache {
    constructor(storage) {
        super('listChannels', () => listChannels(nodeStorage), 60 * 1000, storage )
    }
}

class PendingNodesCache extends APIDataCache {
    constructor(storage, pcCache) {
        super('pendingNodes', async () => checkPendingNodes(await pcCache.data()).pendingBalancesByNodeId, 5 * 60 * 1000, storage )
    }
}

class OpenChannelService {
    constructor() {
        debug('process.env.BASE_STORAGE_DIR=%s', `${process.env.BASE_STORAGE_DIR}/nodes-info`)
        this.storage = storage.create({
            dir: `${process.env.BASE_STORAGE_DIR}/nodes-info`,
            ttl: false
        });
        this.storagePromise = this.storage.init();

        this.wbCache = new WalletBalanceCache(this.storage)
        this.pcCache = new PendingChannelsCache(this.storage)
        this.lcCache = new ListChannelsCache(this.storage)
        this.pnCache = new PendingNodesCache(this.storage, this.pcCache)

        this.lockClients = { byUUID: {}, bySym: {} }
    }

    async init() {
        return this.storagePromise
    }

    async createOpenChannelRequest() {
        let ocb = await this.storage.getItem(OPEN_CHANNEL_LOCK_KEY) || { byUUID: {}, byNodes: {}};
        debug("createOpenChannelRequest: openChannelLocks до: %o", ocb)

        // Формирует уникальный UUID, но балансы нод пока не опрашивает
        let uuid = uuidv4();

        // Сама локировка
        let lock = {
            uuid,
            created: Date.now(),
            redeemed: false,
            pending: false
        };

        ocb.byUUID[uuid] = lock;

        debug("createOpenChannelRequest: openChannelLocks после: %o", ocb)
        await this.storage.setItem(OPEN_CHANNEL_LOCK_KEY, ocb);
        return lock
    }

    async findFreeBalanceForLock(uuidLock, cb) {
        // Лезет в хранилище или переопрашивает снова ноды, имеет также хранилище локировок
        //  возвращает объект локировки, если блокировка была успешна
        let wb, lock = null, changed = false

        if (process.env.TURN_OFF_INBOUND_CHANNELS) {
            console.log('Попытка открытия канала - сообщаем, что нет средств (TURN_OFF_INBOUND_CHANNELS == true)')
            return null
        }

        wb = await this.wbCache.data()
        debug("findFreeBalanceForLock: имеем wb - из кеша или расчитанный, wb: %o", wb)

        let ocb = await this.storage.getItem(OPEN_CHANNEL_LOCK_KEY) || { byUUID: {}, byNodes: {}}
        debug("findFreeBalanceForLock: openChannelLocks до: %o", ocb)

        // Сначала удаляем истекщие блокировки, которые привязаны к заблокированным балансам
        for (let key of _.shuffle(_.keys(wb))) {
            ocb.byNodes[key] = _.defaultTo(ocb.byNodes[key], { key, locks: [], amountLocks: 0 })
            // Проверяем другие блокировки на истёкший срок
            _.remove(ocb.byNodes[key].locks, uuid => {
                let lock = ocb.byUUID[uuid]
                if (Date.now() - lock.created >= OPEN_CHANNEL_LOCK_EXPIRES || lock.redeemed) {
                    // Локировка истекла или использована - удаляем её
                    ocb.byNodes[lock.key].amountLocks -= BALANCE_VALUE_LOCK + RESERVE_OPEN_CHANNEL_SATOSHIES
                    delete ocb.byUUID[lock.uuid]
                    changed = true
                    return 1
                }
                return 0
            })
        }

        // TODO - забыл, но вроде этот код дубликат выше-приведённого
        for (let uuid in ocb.byUUID) {
            let lock = ocb.byUUID[uuid]
            if (Date.now() - lock.created >= OPEN_CHANNEL_LOCK_EXPIRES || lock.redeemed) {
                // Локировка истекла или использована - удаляем её
                delete ocb.byUUID[lock.uuid]
                changed = true
            }
        }

        if ((lock = ocb.byUUID[uuidLock])) {
            // Затем ищём свободные балансы
            for (let key of _.shuffle(_.keys(wb))) {
                if ((wb[key].confirmed_balance - ocb.byNodes[key].amountLocks) >= BALANCE_VALUE_LOCK + RESERVE_OPEN_CHANNEL_SATOSHIES) {
                    let ginfo = await nodeStorage.nodes[key].client.getInfo({})
                    if (ginfo.synced_to_chain) {
                        // Если нода работает (могла бы находится на обслуживании, но отвечать на API)
                        // Здесь есть баланс - ставим блокировку, но из цикла не выходим, чтобы удалить истекшие блокировки
                        // uuid здесь - длинное случайное число - именно оно и используется как k1 в LNURL
                        // Если да - надо как то обрабатывать ситуации, когда сервер рестартует или рестартуем сокет
                        // Сама локировка
                        lock.key = key
                        ocb.byNodes[key].locks.push(uuidLock);
                        ocb.byNodes[key].amountLocks += BALANCE_VALUE_LOCK + RESERVE_OPEN_CHANNEL_SATOSHIES
                        changed = true
                        debug("findFreeBalanceForLock: нашли ноду с таким балансом, lock=%o", lock);
                        cb(null, lock)
                        break
                    }
                }
            }
        }

        if (changed) {
            debug("findFreeBalanceForLock: openChannelLocks после: %o", ocb)
            await this.storage.setItem(OPEN_CHANNEL_LOCK_KEY, ocb);
        }

        if (lock && typeof lock.key === 'undefined') {
            debug("findFreeBalanceForLock: нет в наличии нигде %d sat :(", BALANCE_VALUE_LOCK)
            cb({
                status: 'ERROR',
                reason: 'No free funds for open channel. Please repeat later!'
            })

        }
        else if (! lock){
            debug("findFreeBalanceForLock: не нашли нужной блокировки %s", uuidLock)
            cb({
                status: 'ERROR',
                reason: 'Your lock was redeemed or expired'
            })
        }
    }

    async getResponseOfBalanceLock(uuidLock) {
        let res
        await this.findFreeBalanceForLock(uuidLock, (err, lock) => {
            if (err) {
                res = err
            }
            else {
                res = lock.res = {
                    uri: this.getNodeURI(lock.key),
                    callback: `${process.env.BASE_API_URL}/oc`,
                    k1: lock.uuid,
                    tag: "channelRequest"
                }
            }
        })
        if (res)
            return res
        else {
            console.error('getResponseOfBalanceLock: ошибка, которая не должна была возникнуть')
            return {
                status: 'ERROR',
                reason: "Unknown error! It's very strange :-/"
            }
        }
    }

    async calcNewCapacity(remoteID) {
        return newCapacity(remoteID, await this.lcCache.data())
    }

    // Эта функция вызывается для открытия канала по запросу клиента-кошелька, например BLW
    /*
    *
    * TODO:
    * если privateChannel === null, то надо самим вычислить - какой канал нужно открыть
    * сумма канала должна вычисляться здесь самостоятельно
    * */
    async openChannelByCallback(uuidLock, remoteID, privateChannel) {
        // Только на этом этапе мы знаем публичный ключ ноды remoteID, поэтому только здесь мы можем начать проверки
        // Проверить лимиты на ноду и либо открыть, либо кинуть исключение
        // Входные параметры должны быть проверены ранее и быть валидными

        // Проверяем лимит для данного remoteID
        this.sendIndexToWebsocket(uuidLock, 7)

        let openedNode = await this.storage.getItem(`openedNode-${remoteID}`)
        if (openedNode) {
            // Уже существует - значит этот узел уже открывал с нами канал - ошибка
            debug("openChannelByCallback: попытка открытия повторного канала, нода %s: %o", remoteID, openedNode)
            if (process.env.NODE_ENV === 'production') {
                // Помечаем блокировку как истраченную, чтобы она сразу пометилась и баланс блокировки вернулся обратно
                await this.changeLock(uuidLock,(lock) => {
                    lock.pending = false
                    lock.redeemed = true
                    return 1
                })
                debug('Блокировка %s будет удалена, так как узел повторно открывает новый канал', uuidLock)
                return { status: "ERROR", reason: this.sendErrorToWebsocket(uuidLock,"You have recently opened a channel. Try in 15 minutes!")}
            }
            else {
                debug('Проверку аннулируем, так как работаем не в production режиме')
            }
        }

        let lock = await this.changeLock(uuidLock, (lock) => {
            if (! lock.redeemed && (Date.now() - lock.created) < OPEN_CHANNEL_LOCK_EXPIRES && ! lock.pending) {
                lock.pending = true
                return 1
            }
            return 0
        })

        if (lock) {
            // Значит локировка есть и она прошла наши условия (см. выше)
            // Блокировка не истрачена и время не закончилось
            debug("openChannelByCallback: блокировка валидная - делаем дополнительные проверки и открываем канал: %o", lock)
            // Теперь открываем канал на нужной ноде

            /*
             * Проверка на использование каналов, которые уже были открыты
             * Если узел имеет каналы, которые можно ещё использовать, тогда не позволяем ему бесплатный сервис
             * */
            let newCapacity = await this.calcNewCapacity(remoteID)
            if (newCapacity < 0) {
                // Значит каналы на этот узел уже есть и там достаточно ёмкости - пусть получат сначала
                debug("openChannelByCallback: попытка открытия канала с нодой (%s), которой надо сначала принять достаточно (%d) платежей", remoteID, newCapacity)
                if (process.env.NODE_ENV === 'production') {
                    // Помечаем блокировку как истраченную, чтобы она сразу пометилась и баланс блокировки вернулся обратно
                    await this.changeLock(uuidLock,(lock) => {
                        lock.pending = false
                        lock.redeemed = true
                        return 1
                    })
                    debug('Блокировка %s будет удалена, так как узел открывает новый канал, не использовав существующие каналы', uuidLock)
                    let howMany = -newCapacity / 2 / 1000
                    if (howMany >= 1000) {
                        howMany = Math.round((howMany / 1000 + 0.1) * 10) / 10 + 'M sats'
                    }
                    else {
                        howMany = Math.round(howMany + 1) + 'K sats'
                    }
                    return { status: "ERROR", reason: this.sendErrorToWebsocket(uuidLock, `First, please receive payments in the amount of ${howMany}, or open a channel to us for that amount!`)}
                }
                else {
                    debug('Проверку аннулируем, так как работаем не в production режиме')
                    newCapacity = 1
                }
            }

            let pn = await this.pnCache.data()
            if (pn[remoteID]) {
                // Узел имеет panding каналы - сначала нужно дождаться, когда они пропадут
                debug("openChannelByCallback: попытка открытия канала с нодой (%s), которая имеет pending каналы с другими нашими нодами: %o", remoteID, pn[remoteID])
                if (process.env.NODE_ENV === 'production') {
                    // Помечаем блокировку как истраченную, чтобы она сразу пометилась и баланс блокировки вернулся обратно
                    await this.changeLock(uuidLock,(lock) => {
                        lock.pending = false
                        lock.redeemed = true
                        return 1
                    })
                    let ourNodes = Object.keys(pn[remoteID]).join(', ')
                    debug('Блокировка %s будет удалена, так как узел открывает новый канал, хотя имеет другие pending каналы с нами (%s)', uuidLock, ourNodes)
                    return { status: "ERROR", reason: this.sendErrorToWebsocket(uuidLock, `You have pending channels with us (our nodes: ${ourNodes}). Wait until the channels will be opened and try again!`)}
                }
                else {
                    debug('Проверку аннулируем, так как работаем не в production режиме')
                }
            }

            if (nodeStorage.nodes[lock.key].client) {
                // Значит нода работает - посылаем ей команду
                // Мы здесь - значит newCapacity > 0
                this.sendIndexToWebsocket(uuidLock, 8)
                let fundingAmount = Math.min(Math.ceil((newCapacity + GRATIS_VALUE) / VALUE_QUANTUM), MAX_CHANNEL_VALUE)
                let getinfo
                try {
                    getinfo = await nodeStorage.nodes[lock.key].client.getInfo({})
                }
                catch (e) {
                    getinfo.synced_to_chain = false
                }
                if (! getinfo.synced_to_chain) {
                    return {status: 'ERROR', reason: this.sendErrorToWebsocket(uuidLock, 'Sorry but our node is being maintenanced now. Please try few later!')}
                }
                let res
                try {
                    res = await pTimeout(
                        nodeStorage.nodes[lock.key].client.openChannelSync({
                            node_pubkey: Buffer.from(remoteID, 'hex'),
                            local_funding_amount: fundingAmount,
                            push_sat: 0,
                            target_conf: 12,
                            private: privateChannel,
                            min_htlc_msat: 1,
                            min_confs: 1,
                            spend_unconfirmed: false
                        }),
                        OPEN_CHANNEL_TIMEOUT
                    )
                    debug('Открыт канал из confirmed средств: %o', res)
                }
                catch(e) {
                    debug('Открытие канала из confirmed не сработало, пробуем unconfirmed, error: %s', e.message)

                    if (Date.now() - lock.created >= OPEN_CHANNEL_LOCK_EXPIRES) {
                        //  Если блокировка истекла - ничего не делаем
                        return {status: 'ERROR', reason: this.sendErrorToWebsocket(uuidLock, 'Long opening channel - your lock was expired. Please try again!')}
                    }

                    try {
                        res = await pTimeout(
                            nodeStorage.nodes[lock.key].client.openChannelSync({
                                node_pubkey: Buffer.from(remoteID, 'hex'),
                                local_funding_amount: fundingAmount,
                                push_sat: 0,
                                target_conf: 6,
                                private: privateChannel,
                                min_htlc_msat: 1,
                                min_confs: 0,
                                spend_unconfirmed: true
                            }),
                            OPEN_CHANNEL_TIMEOUT
                        )
                        debug('Открыт канал из unconfirmed средств: %o', res)
                    }
                    catch(e) {
                        debug('Открытие канала из unconfirmed не сработало - отказываем, error: %s', e.message)
                        return {status: 'ERROR', reason: this.sendErrorToWebsocket(uuidLock, 'We cannot open channel. Did your node connect to us?')}
                    }
                }
                debug("res от openChannelSync: %o", res)
                if (res && res.funding_txid && res[res.funding_txid] && typeof res.output_index !== 'undefined') {
                    // Сохраняем блокировку как истраченную
                    lock = await this.changeLock(uuidLock,(lock) => {
                        lock.pending = false
                        lock.redeemed = true
                        return 1
                    })

                    // Сохраняем этот узел в списке узлов, которые воспользовались бесплатным сервисом
                    openedNode = {
                        remoteID,
                        openedTime: Date.now(),
                        valueSatoshies: fundingAmount,
                        newCapacity,
                        privateChannel,
                        uuidLock,
                    }
                    // Сохраняем блокировку
                    await this.storage.setItem(`openedNode-${remoteID}`, openedNode, { ttl: OPEN_CHANNEL_LOCK_TTL })
                    debug("Сохранили эту ноду (%s) в списке воспользовавшихся нод: %o", remoteID, openedNode)

                    debug('p_3, lock: %o', lock)
                    this.sendIndexToWebsocket(uuidLock, 9)
                    debug("Послана команда updateChannelPolicy, она не возвращает результат")
                    return {status: "OK"}
                }
            }
            else {
                await this.changeLock(uuidLock,(lock) => {
                    lock.pending = false
                    return 1
                })
                return {status: 'ERROR', reason: this.sendErrorToWebsocket(uuidLock, 'Sorry but our node is being maintenanced now. Please try few later!')}
            }
        }
        else {
            await this.changeLock(uuidLock,(lock) => {
                lock.pending = false
                return 1
            })
            return {status: 'ERROR', reason: this.sendErrorToWebsocket(uuidLock, typeof lock === 'undefined' ? 'LNURL is not valid already' : 'Your lock was redeemed or expired')}
        }
    }

    sendErrorToWebsocket(uuidLock, text) {
        let ws = this.wsClientByUUID(uuidLock)
        ws && ws.sendCommand('setCurrentOpenChannelErrorByWS', { error: text }, 'openChannel')
        return text
    }

    sendIndexToWebsocket(uuidLock, index) {
        let ws = this.wsClientByUUID(uuidLock)
        ws && ws.sendCommand('setCurrentStageIndexByWS', { openChannelProgressIndex: index }, 'openChannel')
    }

    async changeLock(uuidLock, cb) {
        let ocb = await this.storage.getItem(OPEN_CHANNEL_LOCK_KEY)
        let lock
        if (ocb && ocb.byUUID && (lock = ocb.byUUID[uuidLock])) {
            if (cb(lock)) {
                await this.storage.setItem(OPEN_CHANNEL_LOCK_KEY, ocb)
                return lock
            }
            return null
        }
        return undefined
    }

    // Возвращает объект веб-сокета по uuid запроса на открытие канала
    wsClientByUUID(uuid) {
        return this.lockClients.byUUID[uuid] && clientWebSockets.find(this.lockClients.byUUID[uuid]) || null
    }

    getNodeURI(key) {
        // Пока временно так
        return `${nodeStorage.nodes[key].pubKey}@${key}.${process.env.NODE_DOMAIN || 'LNBIG.com'}:9735`
    }
}

module.exports = OpenChannelService
