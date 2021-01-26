/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

// Должен быть первым - загружает переменные
require('dotenv').config()

let listChannels = require('../lib/listChannels')
let pendingChannels = require('../lib/pendingChannels')
var PromisePool = require('es6-promise-pool')

const pTimeout = require('p-timeout')
const OPEN_CHANNEL_TIMEOUT = 10000

process.umask(0o77);

const nodeStorage = require('../global/nodeStorage');

const debug = require('debug')('lnbig:dwoc')

let
    myNodes = {},
    myInternalChannels = {}

let $listChannels, $pendingChannels

if (process.env.CRYPT_PASSWORD) {
    // The password for crypted macaroon files in env settings (.env file for example)
    main(process.env.CRYPT_PASSWORD)
} else {
    // Or prompt the password from terminal
    var read = require("read");

    read(
        {
            prompt: 'Password: ',
            silent: true,
            replace: '*',
            terminal: true
        },
        (error, password) => {
            if (error)
                throw new Error(error);
            main(password);
        }
    )
}

async function main(password) {
    // To create object for node storage

    // load node storage data included crypted macaroon files, and decrypt macaroon files by password. After the password to be cleaned from memory
    await nodeStorage.init(require('../global/nodesInfo'), password);
    let key

    for (key in nodeStorage.nodes)
        myNodes[nodeStorage.nodes[key].pubKey] = key

    debug("Мои ноды: %o", myNodes)

    // To connect to nodes
    await nodeStorage.connect({longsAsNumbers: false});

    debug('Запускаются асинхронные команды listChannels...')

    $listChannels = listChannels(nodeStorage)
    $pendingChannels = pendingChannels(nodeStorage)

    debug('Ожидается завершение асинхронных команд listChannels...')

    $listChannels = await $listChannels
    $pendingChannels = await $pendingChannels

    debug('Данные получены полностью, обработка')

    for (key in nodeStorage.nodes) {
        if (nodeStorage.nodes[key].client)
            findChannelsToMyNodes(key, $listChannels[key], $pendingChannels[key])
    }

    debug("myInternalChannels после анализа: %o", myInternalChannels)

    openNewChannels()
}

function* openChannelPromise() {
    // Проходим по каналам и собираем информацию для корректировки
    let openChannelData = []

    for (let key1 in nodeStorage.nodes) {
        if (nodeStorage.nodes[key1].client) {
            // Для каждой ноды проверяет - есть каналы со своими
            for (let key2 in nodeStorage.nodes) {
                if (nodeStorage.nodes[key2].client) {
                    // И вот здесь корфмируем список
                    if (   key1 !== key2
                        && (!myInternalChannels[key1] || !myInternalChannels[key1][key2] || myInternalChannels[key1][key2] < 8000000)
                    ){
                        // Канала нет - создаём
                        openChannelData.push({
                            where: key1,
                            pubKey: nodeStorage.nodes[key2].pubKey,
                            address: `${nodeStorage.nodes[key2].internalHost}.${process.env.INTERNAL_DOMAIN_FOR_PUBLIC_INTERFACE}:9735`,
                            amount: 2**24 - 1,
                            rand: Math.random()
                        })
                    }
                }
            }
        }
    }

    openChannelData = openChannelData.sort((a, b) => a.rand- b.rand)

    console.log("Будет открыто %d каналов на сумму: %d BTC", openChannelData.length, openChannelData.reduce((acc,val) => {return acc + val.amount}, 0)/1E8)
    debug("Массив каналов: %o", openChannelData)

    for (let item of openChannelData) {
        console.log("Открытие канала %o", item)
        //yield Promise.resolve(1)
        yield openChannelWithNode(item.pubKey, item.where, item.address, item.amount)
    }
}

async function openNewChannels() {
    // The number of promises to process simultaneously.
    let concurrency = 100

    // Create a pool.
    let pool = new PromisePool(openChannelPromise(), concurrency)

    pool.addEventListener('fulfilled', function () {
        // The event contains:
        // - target:    the PromisePool itself
        // - data:
        //   - promise: the Promise that got fulfilled
        //   - result:  the result of that Promise
        //console.log('update policy: result: %o', event.data.result)
    })

    pool.addEventListener('rejected', function (event) {
        // The event contains:
        // - target:    the PromisePool itself
        // - data:
        //   - promise: the Promise that got rejected
        //   - error:   the Error for the rejection
        console.log('update policy - ОШИБКА: error: %o: ', event.data.error.message)
    })

    console.log(`Запускается открытие каналов (в параллель: ${concurrency})`)

    // Start the pool.
    let poolPromise = pool.start()

    // Wait for the pool to settle.
    await poolPromise
    console.log('Всё завершено успешно')
}

function findChannelsToMyNodes(key, listChannels, pendingChannels) {
    let channel

    // Собираем статистику по каналам, которые уже есть и с теми условиями, с которыми нам надо
    // В данном случае - учитываем те каналы, где есть средства с нашей стороны
    for (channel of listChannels.channels) {
        if (myNodes[channel.remote_pubkey]) {
            // Значит канал с моей ноды - заносим данные
            myInternalChannels[key] = myInternalChannels[key] || {}
            myInternalChannels[key][myNodes[channel.remote_pubkey]] = Math.max(myInternalChannels[key][myNodes[channel.remote_pubkey]] || 0, +channel.local_balance)
        }
    }

    for (channel of pendingChannels.pending_open_channels) {
        if (myNodes[channel.channel.remote_node_pub]) {
            // Значит канал с моей ноды - заносим данные
            myInternalChannels[key] = myInternalChannels[key] || {}
            myInternalChannels[key][myNodes[channel.channel.remote_node_pub]] = Math.max(myInternalChannels[key][myNodes[channel.channel.remote_node_pub]] || 0, +channel.channel.local_balance)
        }
    }
}

async function openChannelWithNode(pubKey, whereOpen, address, amnt = CHANNEL_CAPACITY) {
    let myNode
    try {
        myNode = nodeStorage.nodes[whereOpen]

        let connected = false
        try {
            console.log("p_3, pubKey=%s, whereOpen=%s, address=%s, amnt=%d", pubKey, whereOpen, address, amnt)
            let connect_res = await myNode.client.connectPeer({addr: {pubkey: pubKey, host: address}, perm: false})
            debug("openChannelWithNode(%s): результат коннекта канала: %o", pubKey, connect_res)
            connected = true
        }
        catch (e) {

            if (/already connected to peer/.test(e.message))
                connected = true
            console.log("openChannelWithNode(%s): коннект (%s) НЕУДАЧЕН (%s) - %s...", pubKey, address, e.message, connected ? 'уже подключены - попробуем создать канал' : 'игнорируем эту ноду')
        }

        if (connected) {
            try {
                let res = await pTimeout(
                    // TODO изменить node_pubkey_string здесь и везде на node_pubkey (Buffer.from(pukey, 'hex'))
                    myNode.client.openChannelSync({
                        node_pubkey_string: pubKey,
                        local_funding_amount: amnt,
                        push_sat: 0,
                        target_conf: 30,
                        private: false,
                        remote_csv_delay: 20,
                        min_htlc_msat: 1,
                        min_confs: 0,
                        spend_unconfirmed: true
                    }),
                    OPEN_CHANNEL_TIMEOUT
                )
                console.log("openChannelWithNode(%s): результат открытия канала: %o", pubKey, res)
                return res;
            }
            catch (e) {
                console.error("openChannelWithNode(%s): ошибка (%s) открытия канала (коннект есть), возможно кончились средства (%s)", pubKey, e.message, whereOpen)
                return null
            }
        }
        else {
            return null
        }
    }
    catch (e) {
        console.log("Пойманная ошибка openChannelWithNode(%s) @ %s: %o", pubKey, myNode.key, e)
        throw Error(`Ошибка openChannelWithNode(${pubKey}): ${e.message}, ${e.stack}`)
    }
}
