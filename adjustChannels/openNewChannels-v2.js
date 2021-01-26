/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

// To see algorithm here: https://gist.github.com/LNBIG-COM/dfe5d25bcea25612c559e02fd7698660
// In this file there are many debugging info now. And russian-language comments for me

// Должен быть первым - загружает переменные
require('dotenv').config()
let program = require('commander')
let _ = require('lodash');
const pTimeout = require('p-timeout')

var Lock  = require('file-lock');
const LOCK_FILE = '/tmp/openNewChannels-v2.pid'
const OPEN_CHANNEL_TIMEOUT = 10000

program
    .version('0.1.0')
    .option('-t, --threshold <n>', 'Проходная величина для открытия канала', (str, def) => parseInt(str || def), 6000000)
    .option('-m, --minimal-channel <n>', 'Минимальная величина открываемого канала', (str, def) => parseInt(str || def), 3000000)
    .option('-n, --dry-run', 'Проверочный запуск без действий')
    .parse(process.argv);

console.log("Параметры запуска:\n%sИспользовать threshold для открытия каналов: %d\nМинимальный размер открытого канала: %d",
    program.dryRun ? "Запуск НЕ НАСТОЯЩИЙ\n" : '',
    program.threshold,
    program.minimalChannel
)

let listChannels = require('../lib/listChannels')
let listPeers = require('../lib/listPeers')
let pendingChannels = require('../lib/pendingChannels')
let describeGraph = require('../lib/describeGraph')
let getInfo = require('../lib/getInfo')

var PromisePool = require('es6-promise-pool')
let Long = require('long')

const MAX_CHAN_VALUE = 2**24 - 1
const MIN_SATOSHI_SENT = 100000

process.umask(0o77);

const nodeStorage = require('../global/nodeStorage');

const debug = require('debug')('lnbig:dwoc')

let
    myNodes = {},
    openNodes = {},
    pendingChannelByNodeID = {},
    nodeAddresses = {},
    connectionNodes = {}    // Для нод, которые не имеют публичного IP или Tor - сюда заносим наши сервера, где есть с ними коннект

let $listChannels,
    $listPeers,
    $pendingChannels,
    $describeGraph,
    $getInfo,
    currentBlock = 0;

( async () => {
    let result = await Lock.obtain(LOCK_FILE, process.pid)
    if (result.ok) {
        if (process.env.CRYPT_PASSWORD) {
            // The password for crypted macaroon files in env settings (.env file for example)
            await main(process.env.CRYPT_PASSWORD)
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
                async (error, password) => {
                    if (error)
                        throw new Error(error);
                    await main(password);
                }
            )
        }
        debug("Убираем локировку")
        result = await Lock.release(LOCK_FILE, process.pid)
        debug("Локировка убрана")
        if (! result.ok)
            throw new Error(result.msg)
    }
    else {
        throw new Error(result.msg)
    }
})().then( () => {
    console.log("Все задачи выполнены")
    process.exit(0)
}).catch( e => {console.log("ERROR: %s", e.message)})

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

    await openNewChannels()
}

function* openChannelPromise() {
    // Проходим по каналам и собираем информацию для корректировки
    let openChannelData = []

    for (let key in $listChannels) {
        for (let channel of $listChannels[key].channels) {

            if (   ! channel.private
                && ! myNodes.hasOwnProperty(channel.remote_pubkey)
            )
            {
                // Внешняя нода и в неё было отправлено какое-то количество сатоши
                debug("Анализируем канал: %s, %o", key, channel)
                let item = openNodes[channel.remote_pubkey] = openNodes[channel.remote_pubkey]
                    ||
                    {
                        newCapacity:    0,
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

                if (   ! channel.initiator
                    && Number(channel.total_satoshis_sent) >= MIN_SATOSHI_SENT
                    && Number(channel.total_satoshis_sent) / Number(channel.capacity) >= 0.5
                ) {
                    debug("Канал открыт не нами, но мы активно туда передавали - очень выгодный узел сети!, key: %s, %o", key, channel)
                    item.type.Router++
                }
                else if (   channel.initiator
                    && Number(channel.total_satoshis_received) >= MIN_SATOSHI_SENT
                    && Number(channel.total_satoshis_received) / Number(channel.capacity) >= 0.5
                ) {
                    debug("Канал открыт нами, но удалённая сторона активно передавала в нашу сторону - очень выгодный узел сети!, key: %s, %o", key, channel)
                    item.type.Router++
                }
                else if (    Number(channel.local_balance) >= MIN_SATOSHI_SENT
                          && Number(channel.remote_balance) >= MIN_SATOSHI_SENT
                          && Number(channel.total_satoshis_sent) >= MIN_SATOSHI_SENT
                          && Number(channel.total_satoshis_received) >= MIN_SATOSHI_SENT
                ) {
                    debug("Не имеет значения кем открыт канал, но явно присутствуют признаки передачи в разных направлениях, хотя и не такие сильные, как другие routers условия, key: %s, %o", key, channel)
                    // Канал похож на роутинговый узел, передающий в оба направления
                    item.type.Router++
                }
                else if (    Number(channel.total_satoshis_sent) >= MIN_SATOSHI_SENT
                          && Number(channel.total_satoshis_sent) / Number(channel.capacity) >= 0.5
                          && Number(channel.remote_balance) / Number(channel.capacity) >= 0.7
                ) {
                    item.type.Vacuum++
                }
                else if (   channel.initiator
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

                channel.isPendingHTLC = channel.isPendingHTLC || ! ! channel.pending_htlcs.length

                item.amountChannels++

/*
                Решил использовать новый алгоритм определения того, сколько надо создать новой ликвидности на ноду:
                В новом алгоритме плюсуется разница (newCapacity) между серединой ёмкости канала и локальным балансом
                Если уже открыто много каналов, где локальный баланс больше середины (имеем излишнюю ликвидность), тогда
                сумма (newCapacity) всех этих разниц уходит в минус - значит новый канал не нужен (ликвидности и так достаточно в то направление)

                Если много истощённых каналов с нашей стороны, то сумма newCapacity будет увеличиваться. Причём чем больше истощённых каналов,
                тем сумма будет больше.

                Затем, после прохождения всех каналов узла, получив newCapacity, мы далее действуем так:
                Если newCapacity <= 0 - смысла открывать нового канала нет - много каналов с ликвидностью с нашей стороны
                иначе получаем newCapacity * 2 и если оно выше пороговой величины - открываем канал на эту сумму
*/

                // Здесь сразу умножаю на два, чтобы потом не делать
                item.newCapacity += (Number(channel.capacity) / 2 - Number(channel.local_balance)) * 2
                debug("newCapacity текущее: %d (key: %s, %o)", item.newCapacity, key, channel)

                debug("Для канала получили данные: %o", item)
            }
        }
    }

    for (let pubKey in openNodes) {
        let item = openNodes[pubKey]

        debug("Данные узла: %o", item)
        // Сначала определяем тип ноды и отвечаем на вопрос: надо ли нам создавать там канал
        let toOpenChannel = false

        if (item.type.Vampire > 0) {
            // С нодой есть вампир каналы
            if (item.type.Vacuum > 0)
                console.log("Vampire/Vacuum/NewOpened/Pending (%d/%d/%d/%d)/(%d): %s", item.type.Vampire, item.type.Vacuum, item.type.NewOpened, item.type.Pending, item.newCapacity, pubKey)
            else
                console.log("Vampire/NewOpened/Pending (%d/%d/%d)/(%d): %s", item.type.Vampire, item.type.NewOpened, item.type.Pending, item.newCapacity, pubKey)
        }
        else if (item.type.Vacuum > 0) {
            if (item.type.Router > 0)
                console.log("Vacuum/Router/NewOpened/Pending (%d/%d/%d/%d)/(%d): %s", item.type.Vacuum, item.type.Router, item.type.NewOpened, item.type.Pending, item.newCapacity, pubKey)
            else
                console.log("Vacuum/NewOpened/Pending (%d/%d/%d)/(%d): %s", item.type.Vacuum, item.type.NewOpened, item.type.Pending, item.newCapacity, pubKey)
        }
        else if (item.type.Router > 0) {
            console.log("Router/NewOpened/Pending (%d/%d/%d)/(%d): %s", item.type.Router, item.type.NewOpened, item.type.Pending, item.newCapacity, pubKey)
        }

        // TODO Сделать потом учёт - какие ноды закрывают каналы вскоре, как мы откроем на них канал - есть ноды, которые кооперативно или нет закрывают каналы
        // например - это могут быть Tor ноды, которые не хотят получать платежи. В таких случаях надо переставать открывать на них каналы (список не желающих)
        toOpenChannel = item.newCapacity >= program.threshold && item.type.Pending === 0 && item.type.NotActive === 0

        if (toOpenChannel) {
            let minimalAmnt = Math.round(item.newCapacity < program.minimalChannel ? program.minimalChannel : item.newCapacity)
            let data
            if (nodeAddresses[pubKey]) {
                // У неё есть IP address
                let where = Object.keys(nodeStorage.nodes).filter(val => ! (pendingChannelByNodeID[pubKey] && pendingChannelByNodeID[pubKey][val]))
                if (where.length)
                    data = {
                        where: where,
                        pubKey: pubKey,
                        address: nodeAddresses[pubKey],
                        amount: minimalAmnt
                    }
            }
            else if (connectionNodes[pubKey]) {
                data = {
                    where: connectionNodes[pubKey],
                    pubKey: pubKey,
                    address: null,
                    amount: minimalAmnt
                }
            }
            else {
                console.log("Хочется открыть канал с нодой %s, но публичного IP4 у неё нет :(", pubKey)
            }

            if (data) {
                if (data.amount > MAX_CHAN_VALUE)
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
                if (/no route to host/.test(e.message))
                    return null
            }

            if (connected) {
                try {
                    debug("openChannelWithNodes(%s): API открытия канала...", pubKey)
                    let res = await pTimeout(
                        myNode.client.openChannelSync({
                            node_pubkey_string: pubKey,
                            local_funding_amount: amnt,
                            push_sat: 0,
                            target_conf: 24,
                            private: false,
                            min_htlc_msat: 1,
                            min_confs: 0,
                            spend_unconfirmed: true
                        }),
                        OPEN_CHANNEL_TIMEOUT
                    )
                    debug("openChannelWithNodes(%s): результат открытия канала: %o", pubKey, res)
                    console.log("Канал (%s <--> %s / %d sats) успешно открыт!", whereOpen, pubKey, amnt)
                    return res
                }
                catch (e) {
                    let res, minReq = false

                    if ((res = /chan size of ([\d.]+) BTC is below min chan size of ([\d.]+) BTC/.exec(e.message)) !== null) {
                        amnt = Math.round(Number(res[2]) * 100000000)
                        minReq = true
                    }
                    else if ((res = /invalid funding_satoshis=(\d+) \(min=(\d+) max=(\d+)\)/.exec(e.message))) {
                        amnt = Math.round(Number(res[2]))
                        minReq = true
                    }
                    else if ((res = /Promise timed out after \d+ milliseconds/.exec(e.message))) {
                        return null
                    }

                    if (minReq) {
                        // Удалённый узел требует минимального размера канала - пробуем удовлетворить его просьбу
                        console.log("Удалённый узел требует минимального размера канала (%d BTC) - пробуем удовлетворить его просьбу", amnt / 100000000)
                        if (amnt > MAX_CHAN_VALUE)
                            amnt = MAX_CHAN_VALUE
                        try {
                            let res = await pTimeout(
                                myNode.client.openChannelSync({
                                    //node_pubkey: Buffer.from(pubKey, 'hex'),
                                    node_pubkey_string: pubKey,
                                    local_funding_amount: amnt,
                                    push_sat: 0,
                                    target_conf: 24,
                                    private: false,
                                    min_htlc_msat: 1,
                                    min_confs: 0,
                                    spend_unconfirmed: true
                                }),
                                OPEN_CHANNEL_TIMEOUT
                            )
                            debug("openChannelWithNodes(%s): результат открытия канала: %o", pubKey, res)
                            console.log("Канал (%s <--> %s / %d sats) успешно открыт!", whereOpen, pubKey, amnt)
                            return res
                        }
                        catch (e) {
                            console.log("openChannelWithNodes(%s): ошибка (%s) открытия канала (коннект есть), возможно кончились средства (%s)", pubKey, e.message, whereOpen)
                            continue
                        }
                    }
                    else if (address === null && (res = /not enough witness outputs to create funding transaction, need ([\d.]+) BTC only have ([\d.]+) BTC/.exec(e.message)) !== null) {
                        // У нас есть коннект с этой нодой без публичного IP на этом сервере, но при этом у нас не хватает средств - пробуем открыть меньший канал
                        let amnt = Math.round(Number(res[2]) * 100000000 - 50000)
                        if (amnt > MAX_CHAN_VALUE)
                            amnt = MAX_CHAN_VALUE
                        if (amnt >= program.threshold) {
                            // Открываем только если мы имеем минимум для канала
                            try {
                                let res = await pTimeout(
                                    myNode.client.openChannelSync({
                                        //node_pubkey: Buffer.from(pubKey, 'hex'),
                                        node_pubkey_string: pubKey,
                                        local_funding_amount: amnt,
                                        push_sat: 0,
                                        target_conf: 24,
                                        private: false,
                                        min_htlc_msat: 1,
                                        min_confs: 0,
                                        spend_unconfirmed: true
                                    }),
                                    OPEN_CHANNEL_TIMEOUT
                                )
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
                            console.log("Мы имеем коннект с узлом (%s <--> %s), который не имеет публичного IP, но не можем открыть канал - недостаточно средств (%d sats) для минимума канала", pubKey, whereOpen, amnt)
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
