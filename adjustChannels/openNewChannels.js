/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

// Должен быть первым - загружает переменные
require('dotenv').config()
var program = require('commander')
var _ = require('lodash');

program
    .version('0.1.0')
    .option('-n, --dry-run', 'Проверочный запуск без действий')
    .parse(process.argv);

let listChannels = require('../lib/listChannels')
let listPeers = require('../lib/listPeers')
let pendingChannels = require('../lib/pendingChannels')
let describeGraph = require('../lib/describeGraph')
let getInfo = require('../lib/getInfo')

var PromisePool = require('es6-promise-pool')
let Long = require('long')

const MIN_CHAN_VALUE = 6000000;
const MAX_CHAN_VALUE = 2**24 - 1;
const MIN_SATOSHI_SENT = 100000;

process.umask(0o77);

const nodeStorage = require('../global/nodeStorage');

const debug = require('debug')('lnbig:dwoc')

let
    myNodes = {},
    openNodes = {},
    //openedChannelByNodeID = {},
    pendingChannelByNodeID = {},
    nodeAddresses = {},
    connectionNodes = {}    // Для нод, которые не имеют публичного IP или Tor - сюда заносим наши сервера, где есть с ними коннект

let $listChannels, $pendingChannels, $describeGraph, $getInfo, currentBlock = 0

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
    $listPeers = listPeers(nodeStorage)
    $pendingChannels = pendingChannels(nodeStorage)
    $describeGraph = describeGraph(nodeStorage)
    $getInfo      = getInfo(nodeStorage)

    debug('Ожидается завершение асинхронных команд listChannels...')

    $listChannels = await $listChannels
    $listPeers = await $listPeers
    $pendingChannels = await $pendingChannels
    $describeGraph  = await $describeGraph
    $getInfo  = await $getInfo

    debug('Данные получены полностью, обработка')

    for (key in nodeStorage.nodes) {
        if (nodeStorage.nodes[key].client) {
            defineAddresses($describeGraph[key]);
        }
    }

    for (key in nodeStorage.nodes) {
        if (nodeStorage.nodes[key].client) {
            defineConnectionNodes(key, $listPeers[key]);
        }
    }

    for (key in nodeStorage.nodes) {
        if (nodeStorage.nodes[key].client)
            calculateByNodeID(key, $listChannels[key], $pendingChannels[key])
    }

    openNewChannels()
}

function* openChannelPromise() {
    // Проходим по каналам и собираем информацию для корректировки
    let openChannelData = []

    for (let key in $listChannels) {
        for (let channel of $listChannels[key].channels) {
            /*
            if (   ! channel.initiator
                && Number(channel.total_satoshis_sent) > Number(channel.total_satoshis_received)
            ) {
                // 2 - Такое только может быть, если кто-то открыл на нас канал и сделал push по ошибке
                console.log("a_1, key: %s, %o", key, channel)
            }

            if (   ! channel.initiator
                && Number(channel.total_satoshis_sent) < Number(channel.total_satoshis_received)
            ) {
                // 1785 - норма - открыли канал на нас и передавали в нашем направлении
                console.log("a_2, key: %s, %o", key, channel)
            }

            if (   ! channel.initiator
                && Number(channel.total_satoshis_sent) < Number(channel.total_satoshis_received)
                && ! (Number(channel.total_satoshis_received) - Number(channel.total_satoshis_sent) === Number(channel.local_balance))
            ) {
                // 189 - если разница больше 1 - скорее всего инициатор по ошибке пушнул в нашу сторону - такие каналы есть
                console.log("a_2a, key: %s, %o", key, channel)
                console.log("a_2b, %d", Number(channel.total_satoshis_received) - Number(channel.total_satoshis_sent) - Number(channel.local_balance))
            }

            if (   ! channel.initiator
                && Number(channel.total_satoshis_sent) < Number(channel.total_satoshis_received)
                && Number(channel.total_satoshis_received) >0
                && Number(channel.total_satoshis_sent) > 0
            ) {
                // Проверить
                console.log("a_2c, key: %s, %o", key, channel)
            }

            if (   ! channel.initiator
                && Number(channel.total_satoshis_sent) === Number(channel.total_satoshis_received)
            ) {
                // 2090 - Возникает часто, если канал открыли на нас, но в канале ещё ничего не передавали
                console.log("a_3, key: %s, %o", key, channel)
            }

            if (   channel.initiator
                && Number(channel.total_satoshis_sent) > Number(channel.total_satoshis_received)
            ) {
                // 3182 - типичная ситуация, когда мы открыли канал и начали передавать в том направлении
                console.log("a_4, key: %s, %o", key, channel)
            }

            if (   channel.initiator
                && Number(channel.total_satoshis_sent) > Number(channel.total_satoshis_received)
                && Number(channel.total_satoshis_received) > 0
                && Number(channel.total_satoshis_sent) > 0
            ) {
                // 1259
                console.log("a_4c, key: %s, %o", key, channel)
            }

            if (   channel.initiator
                && Number(channel.total_satoshis_sent) > Number(channel.total_satoshis_received)
                && Number(channel.total_satoshis_received) > 0
                && Number(channel.total_satoshis_sent) > 0
            ) {
                // Разница либо 0 либо 1, и один раз только 3001 - из-за старого pending_htlcs
                console.log("a_4d, %d", Number(channel.total_satoshis_sent) - Number(channel.total_satoshis_received) - Number(channel.remote_balance))
            }

            if (   channel.initiator
                && Number(channel.total_satoshis_sent) < Number(channel.total_satoshis_received)
            ) {
                // 0 - Если мы открывали канал и пушали - этого не должно быть
                console.log("a_5, key: %s, %o", key, channel)
            }

            if (   channel.initiator
                && Number(channel.total_satoshis_sent) === Number(channel.total_satoshis_received)
            ) {
                // 3153 - норма - открывали канал мы и ничего не парадавали
                console.log("a_6, key: %s, %o", key, channel)
            }
            */

            if (   ! channel.private
                && ! myNodes.hasOwnProperty(channel.remote_pubkey)
            )
            {
                // Внешняя нода и в неё было отправлено какое-то количество сатоши
                debug("Анализируем канал: %s, %o", key, channel)
                let item = openNodes[channel.remote_pubkey] = openNodes[channel.remote_pubkey]
                    ||
                    {
                        capacityAmnt:  0,
                        capacitySum:   0,
                        weAreInitiator: 0,
                        amountChannels: 0,
                        isPendingHTLC:  false,  // Если есть хотя бы один зависший HTLC - не будем создавать канал
                        pubKey:         channel.remote_pubkey,
                        myNodes:        {},
                        type:           {
                            NotActive: 0,
                            Vacuum:    0,
                            Vampire:   0,
                            NewOpened: 0,
                            Router:    0,
                            Pending:   pendingChannelByNodeID[channel.remote_pubkey] ? Object.keys(pendingChannelByNodeID[channel.remote_pubkey]).length : 0
                        },
                    }

                item.blockHeight = Long.fromString(channel.chan_id, true)
                item.chan_id = Long.fromString(channel.chan_id, true)
                item.blockHeight = item.blockHeight.shru(40).toNumber()

                if (! channel.active)
                    item.type.NotActive++

                if (channel.initiator)
                    item.weAreInitiator++

                if (   channel.initiator
                    && Number(channel.total_satoshis_sent) >= MIN_SATOSHI_SENT
                    && Number(channel.total_satoshis_sent) === Number(channel.remote_balance)
                ) {
                    // Канал открыли мы и он был использован только для передачи в одну сторону
                    item.type.Vacuum++
                }

                if (channel.initiator && Number(channel.total_satoshis_sent) === 0 && Number(channel.local_balance) > 0) {
                    if ((currentBlock - item.blockHeight) >= 144 * 14)
                        // Канал открыли мы, ему больше двух недель и он не был использован
                        item.type.Vampire++
                    else
                        // Канал открыли мы, но менее двух недель назад - рано делать выводы...
                        item.type.NewOpened++
                }

                if (    Number(channel.local_balance) >= MIN_SATOSHI_SENT
                     && Number(channel.remote_balance) >= MIN_SATOSHI_SENT
                     && Number(channel.total_satoshis_sent) >= MIN_SATOSHI_SENT
                     && Number(channel.total_satoshis_received) >= MIN_SATOSHI_SENT
                ) {
                    // Канал похож на роутинговый узел, передающий в оба направления
                    item.type.Router++
                }

                channel.isPendingHTLC = channel.isPendingHTLC || ! ! channel.pending_htlcs.length

                item.amountChannels++

                item.capacitySum += Number(channel.total_satoshis_sent)
                item.capacityAmnt++
                item.myNodes[key] = {key: key, total_satoshis_sent: channel.total_satoshis_sent}

                debug("Для канала получили данные: %o", item)
            }
        }
    }

    for (let pubKey in openNodes) {
        let item = openNodes[pubKey]

        item.capacityAverage = item.capacitySum / item.capacityAmnt
        debug("Данные узла: %o", item)
        // Сначала определяем тип ноды и отвечаем на вопрос: надо ли нам создавать там канал
        let toOpenChannel = false

        if (item.type.Vampire > 0) {
            // С нодой есть вампир каналы
            if (item.type.Vacuum > 0)
                console.log("Vampire/Vacuum/NewOpened/Pending (%d/%d/%d/%d): %s", item.type.Vampire, item.type.Vacuum, item.type.NewOpened, item.type.Pending, pubKey)
            else
                console.log("Vampire/NewOpened/Pending (%d/%d/%d): %s", item.type.Vampire, item.type.NewOpened, item.type.Pending, pubKey)
        }
        else if (item.type.Vacuum > 0) {
            if (item.type.Router > 0)
                console.log("Vacuum/Router/NewOpened/Pending (%d/%d/%d/%d): %s", item.type.Vacuum, item.type.Router, item.type.NewOpened, item.type.Pending, pubKey)
            else
                console.log("Vacuum/NewOpened/Pending (%d/%d/%d): %s", item.type.Vacuum, item.type.NewOpened, item.type.Pending, pubKey)
            toOpenChannel = item.capacitySum >= MIN_SATOSHI_SENT && item.type.NewOpened === 0 && item.type.Pending === 0 && item.type.NotActive === 0
        }
        else if (item.type.Router > 0) {
            console.log("Router/NewOpened/Pending (%d/%d/%d): %s", item.type.Router, item.type.NewOpened, item.type.Pending, pubKey)
            toOpenChannel = item.capacitySum >= MIN_SATOSHI_SENT && item.type.NewOpened === 0 && item.type.Pending === 0 && item.type.NotActive === 0
        }

        if (toOpenChannel) {
            let data
            if (nodeAddresses[pubKey]) {
                // У неё есть IP address
                let where = Object.keys(nodeStorage.nodes).filter(val => ! (pendingChannelByNodeID[pubKey] && pendingChannelByNodeID[pubKey][val]))
                if (where.length)
                    data = {
                        where: where,
                        pubKey: pubKey,
                        address: nodeAddresses[pubKey],
                        amount: Math.round(item.capacitySum * 2)
                    }
            }
            else if (connectionNodes[pubKey]) {
                data = {
                    where: connectionNodes[pubKey],
                    pubKey: pubKey,
                    address: null,
                    amount: Math.round(item.capacitySum * 2)
                }
            }
            else {
                console.log("Хочется открыть канал с нодой %s, но публичного IP4 у неё нет :(", pubKey)
            }

            if (data) {
                if (data.amount < MIN_CHAN_VALUE)
                    data.amount = MIN_CHAN_VALUE
                else if (data.amount > MAX_CHAN_VALUE)
                    data.amount = MAX_CHAN_VALUE
                debug("Будет открыт канал на нодах %o с remote %s на сумму %d", data.where, data.pubKey, data.amount)
                openChannelData.push(data)

            }
        }

    }

    openChannelData = _.shuffle(openChannelData)

    console.log("Будет открыто %d каналов на сумму: %d BTC", openChannelData.length, openChannelData.reduce((acc,val) => {return acc + val.amount}, 0)/1E8)

    for (let item of openChannelData) {
        debug("Открытие канала %o", item)
        if (program.dryRun)
            yield Promise.resolve(1)
        else
            yield openChannelWithNodes(item.pubKey, item.where, item.address, item.amount)
    }
}

async function openNewChannels() {
    // The number of promises to process simultaneously.
    let concurrency = 100

    // Create a pool.
    let pool = new PromisePool(openChannelPromise(), concurrency)

    pool.addEventListener('fulfilled', function (event) {
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

    console.log(`Запускается update каналов (в параллель: ${concurrency})`)

    // Start the pool.
    let poolPromise = pool.start()

    // Wait for the pool to settle.
    await poolPromise
    console.log('Всё завершено успешно')
}

function calculateByNodeID(key, listChannels, pendingChannels) {
    let channel

    currentBlock = Math.max(currentBlock, Number($getInfo[key].block_height))

    // // Собираем статистику по каналам, которые уже есть и с теми условиями, с которыми нам надо
    // // В данном случае - учитываем те каналы, где есть средства с нашей стороны
    // for (channel of listChannels.channels) {
    //     if (channel.local_balance > 0) {
    //         openedChannelByNodeID[channel.remote_pubkey] = openedChannelByNodeID[channel.remote_pubkey] || {}
    //         openedChannelByNodeID[channel.remote_pubkey][key] = Math.max(openedChannelByNodeID[channel.remote_pubkey][key] || 0, channel.local_balance)
    //     }
    // }

    for (channel of pendingChannels.pending_open_channels) {
        if (channel.channel.local_balance > 0) {
            pendingChannelByNodeID[channel.channel.remote_node_pub] = pendingChannelByNodeID[channel.channel.remote_node_pub] || {}
            pendingChannelByNodeID[channel.channel.remote_node_pub][key] = Math.max(pendingChannelByNodeID[channel.channel.remote_node_pub][key] || 0, channel.channel.local_balance)
        }
    }

    for (channel of pendingChannels.pending_closing_channels) {
        if (channel.channel.local_balance > 0) {
            pendingChannelByNodeID[channel.channel.remote_node_pub] = pendingChannelByNodeID[channel.channel.remote_node_pub] || {}
            pendingChannelByNodeID[channel.channel.remote_node_pub][key] = Math.max(pendingChannelByNodeID[channel.channel.remote_node_pub][key] || 0, channel.channel.local_balance)
        }
    }

    for (channel of pendingChannels.pending_force_closing_channels) {
        if (channel.channel.local_balance > 0) {
            pendingChannelByNodeID[channel.channel.remote_node_pub] = pendingChannelByNodeID[channel.channel.remote_node_pub] || {}
            pendingChannelByNodeID[channel.channel.remote_node_pub][key] = Math.max(pendingChannelByNodeID[channel.channel.remote_node_pub][key] || 0, channel.channel.local_balance)
        }
    }

    for (channel of pendingChannels.waiting_close_channels) {
        if (channel.channel.local_balance > 0) {
            pendingChannelByNodeID[channel.channel.remote_node_pub] = pendingChannelByNodeID[channel.channel.remote_node_pub] || {}
            pendingChannelByNodeID[channel.channel.remote_node_pub][key] = Math.max(pendingChannelByNodeID[channel.channel.remote_node_pub][key] || 0, channel.channel.local_balance)
        }
    }
}

async function openChannelWithNodes(pubKey, whereOpenArray, address, amnt) {
    let myNode
    for (let whereOpen of _.shuffle(whereOpenArray)) {
        try {
            myNode = nodeStorage.nodes[whereOpen]

            let connected = false
            try {
                if (address) {
                    console.log("Коннект (%s) на ноду (%s @ %s) для открытия канала", address, pubKey, whereOpen)
                    let connect_res = await myNode.client.connectPeer({addr: {pubkey: pubKey, host: address}, perm: false})
                    debug("openChannelWithNodes(%s): результат коннекта канала: %o", pubKey, connect_res)
                    connected = true
                }
                else {
                    // address === null: там уже есть коннект с нодой whereOpen, а публичного адреса нет
                    console.log("На ноду %s не коннектимся, так как публичного IP у неё нет, но у нас с ней есть коннект на %s", pubKey, whereOpen)
                    connected = true
                }
            }
            catch (e) {

                if (/already connected to peer/.test(e.message))
                    connected = true
                console.log("openChannelWithNodes(%s): коннект (%s) НЕУДАЧЕН (%s) - %s...", pubKey, address, e.message, connected ? 'уже подключены - попробуем создать канал' : 'игнорируем эту ноду')
                if (/connection timed out/.test(e.message))
                    return null
                if (/connection refused/.test(e.message))
                    return null
            }

            if (connected) {
                try {
                    let res = await myNode.client.openChannelSync({
                        //node_pubkey: Buffer.from(pubKey, 'hex'),
                        node_pubkey_string: pubKey,
                        local_funding_amount: amnt,
                        push_sat: 0,
                        target_conf: 12,
                        private: false,
                        remote_csv_delay: 40,
                        min_htlc_msat: 1,
                        min_confs: 0,
                        spend_unconfirmed: true
                    })
                    debug("openChannelWithNodes(%s): результат открытия канала: %o", pubKey, res)
                    console.log("Канал (%s <--> %s / %d sats) успешно открыт!", whereOpen, pubKey, amnt)
                    return res
                }
                catch (e) {
                    let res
                    if ((res = /chan size of ([\d\.]+) BTC is below min chan size of ([\d\.]+) BTC/.exec(e.message)) !== null) {
                        // Удалённый узел требует минимального размера канала - пробуем удовлетворить его просьбу
                        console.log("Удалённый узел требует минимального размера канала (%d BTC) - пробуем удовлетворить его просьбу", res[2])
                        amnt = Number(res[2]) * 100000000
                        if (amnt < MIN_CHAN_VALUE)
                            amnt = MIN_CHAN_VALUE
                        else if (amnt > MAX_CHAN_VALUE)
                            amnt = MAX_CHAN_VALUE
                        try {
                            let res = await myNode.client.openChannelSync({
                                //node_pubkey: Buffer.from(pubKey, 'hex'),
                                node_pubkey_string: pubKey,
                                local_funding_amount: amnt,
                                push_sat: 0,
                                target_conf: 12,
                                private: false,
                                remote_csv_delay: 40,
                                min_htlc_msat: 1,
                                min_confs: 0,
                                spend_unconfirmed: true
                            })
                            debug("openChannelWithNodes(%s): результат открытия канала: %o", pubKey, res)
                            console.log("Канал (%s <--> %s / %d sats) успешно открыт!", whereOpen, pubKey, amnt)
                            return res
                        }
                        catch (e) {
                            console.log("openChannelWithNodes(%s): ошибка (%s) открытия канала (коннект есть), возможно кончились средства (%s)", pubKey, e.message, whereOpen)
                            continue
                        }
                    }
                    else {
                        if (/Multiple channels unsupported/.test(e.message)) {
                            // Достаточно продолжить открытие на другом узле
                            console.log("Узел %s не поддерживает несколько каналов с одной нодой (%s) - пробуем дальше", pubKey, whereOpen)
                        }
                        else {
                            console.log("openChannelWithNodes(%s): ошибка (%s) открытия канала (коннект есть), возможно кончились средства (%s)", pubKey, e.message, whereOpen)
                        }
                    }
                    continue
                }
            }
            else {
                continue
            }
        }
        catch (e) {
            console.log("Пойманная ошибка openChannelWithNodes(%s) @ %s: %o", pubKey, myNode.key, e)
            throw Error(`Ошибка openChannelWithNodes(${pubKey}): ${e.message}, ${e.stack}`)
        }
    }
    return null
}

function defineAddresses(describeGraph) {
    for(let node of describeGraph.nodes) {
        if ( ! nodeAddresses.hasOwnProperty(node.pub_key)) {
            let addr =  node.addresses.filter( val => val.network == 'tcp' && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(val.addr) )[0]
            if (addr) {
                nodeAddresses[node.pub_key] = addr.addr
            }
        }
    }
}

function defineConnectionNodes(key, listPeers) {
    for(let peer of listPeers.peers) {
        if (! nodeAddresses.hasOwnProperty(peer.pub_key)) {
            console.log("Узел %s не имеет публичного IP, но он имеет коннект на %s - будем в том числе там создавать канал", peer.pub_key, key)
            connectionNodes[peer.pub_key] = connectionNodes[peer.pub_key] || []
            connectionNodes[peer.pub_key].push(key)
        }

    }
}
