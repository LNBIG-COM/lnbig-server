// To see algorithm here: https://gist.github.com/LNBIG-COM/dfe5d25bcea25612c559e02fd7698660
// In this file there are many debugging info now. And russian-language comments for me

// Должен быть первым - загружает переменные
require('dotenv').config()
let program = require('commander')
let _ = require('lodash');
const pTimeout = require('p-timeout')
const {pendingNodes, currentBlockchainBlock} = require('../lib/utilChannels')
const grpc = require('grpc')

var Lock  = require('file-lock');
const LOCK_FILE = '/run/lock/open-close-channels.pid'
const OPEN_CHANNEL_TIMEOUT = 10000

let command, options

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
    statNodes = {},
    pendingChannelByNodeID,
    nodeAddresses = {},
    connectionNodes = {}    // Для нод, которые не имеют публичного IP или Tor - сюда заносим наши сервера, где есть с ними коннект

let $listChannels,
    $listPeers,
    $pendingChannels,
    $describeGraph,
    $getInfo,
    currentBlock

program
    .version('0.1.0')

program
    .command('open')
    .option('-t, --threshold <n>', 'Проходная величина для открытия канала', (str, def) => parseInt(str || def), 6000000)
    .option('-m, --minimal-channel <n>', 'Минимальная величина открываемого канала', (str, def) => parseInt(str || def), 3000000)
    .option('-n, --dry-run', 'Проверочный запуск без действий для открытия каналов')
    .action((opts) => {
        command = 'open'
        options = opts
        main()
    })

program
    .command('close')
    .option('-t, --threshold <n>', 'Величина threshold, которая используется для открытия каналов', (str, def) => parseInt(str || def), 6000000)
    .option('-n, --dry-run', 'Проверочный запуск без действий')
    .option('-f, --forced', 'Закрывать каналы, которые можно закрыть как forced (только не активные каналы в данный момент)')
    .option('-o, --older-days <n>', 'Скольки старее дней должны быть каналы', (str, def) => parseInt(str || def), 60)
    .option('-m, --max-btc <n>', 'Скольки максимум освободить BTC', parseFloat)
    .action((opts) => {
        command = 'close'
        options = opts
        main()
    })

program
    .parse(process.argv);

function main () {
    console.log("Параметры запуска:\nКомманда: %s%s",
        command,
        options.dryRun ? " (Запуск НЕ НАСТОЯЩИЙ)\n" : ''
    )
    ;( async () => {
        let result = await Lock.obtain(LOCK_FILE, process.pid)
        if (result.ok) {
            if (process.env.CRYPT_PASSWORD) {
                // The password for crypted macaroon files in env settings (.env file for example)
                await _main(process.env.CRYPT_PASSWORD)
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
                        await _main(password);
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
}

async function _main(password) {
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

    $listChannels = listChannels(nodeStorage, command === 'close' ? (options.forced ? { inactive_only: true } : { active_only: true }) : undefined)
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

    currentBlock = currentBlockchainBlock($getInfo)
    pendingChannelByNodeID = pendingNodes($pendingChannels)

    await openNewChannels()
}

function* commandChannelPromise() {
    // Проходим по каналам и собираем информацию для корректировки
    let channelCommands = []
    let willBeFree = 0, maxBTC = options.maxBtc

    for (let key in $listChannels) {
        for (let channel of $listChannels[key].channels) {
            if (! myNodes.hasOwnProperty(channel.remote_pubkey))
            {
                // Внешняя нода и в неё было отправлено какое-то количество сатоши
                debug("Анализируем канал: %s, %o", key, channel)
                let item = statNodes[channel.remote_pubkey] = statNodes[channel.remote_pubkey]
                    ||
                    {
                        newCapacity:           0,
                        amountChannels:        0,
                        amountPrivateChannels: 0,
                        notActive:             0,
                        isPendingHTLC:         false       ,  // Если есть хотя бы один зависший HTLC - не будем создавать канал
                        pubKey:                channel.remote_pubkey,
                        myNodes:               {},
                        pending:               pendingChannelByNodeID[channel.remote_pubkey] ? Object.keys(pendingChannelByNodeID[channel.remote_pubkey]).length : 0,
                        closeChallengers:      [],
                    };

                if (channel.private)
                    item.amountPrivateChannels++

                let blockHeight = Long.fromString(channel.chan_id, true).shru(40).toNumber()
                item.isPendingHTLC = item.isPendingHTLC || !!+ channel.pending_htlcs.length

                if (! channel.active)
                    item.notActive++

                item.amountChannels++

                // Здесь сразу умножаю на два, чтобы потом не делать
                item.newCapacity += (+channel.capacity / 2 - +channel.local_balance) * 2

                if (! channel.pending_htlcs.length
                    && channel.initiator
                    && channel.remote_balance == 0
                    && (currentBlock - blockHeight) >= options.olderDays * 144
                ) {
                    debug('Претендет-канал на закрытие: %o', channel)
                    item.closeChallengers.push({channel, key})
                }

                debug("newCapacity текущее: %d (key: %s, %o)", item.newCapacity, key, channel)
                debug("Для канала получили данные: %o", item)
            }
        }
    }

    for (let pubKey of _.shuffle(Object.keys(statNodes))) {
        let item = statNodes[pubKey]

        debug("Данные узла: %o", item)
        // Сначала определяем тип ноды и отвечаем на вопрос: надо ли нам создавать там канал
        let toOpenChannel  = false
        let toCloseChannel = false

        // TODO Сделать потом учёт - какие ноды закрывают каналы вскоре, как мы откроем на них канал - есть ноды, которые кооперативно или нет закрывают каналы
        // например - это могут быть Tor ноды, которые не хотят получать платежи. В таких случаях надо переставать открывать на них каналы (список не желающих)
        toOpenChannel = item.newCapacity >= options.threshold && item.pending === 0 && item.notActive === 0 && ! item.amountPrivateChannels
        item.closeChallengers = item.closeChallengers.sort((a, b) => +b.channel.capacity - +a.channel.capacity)
        toCloseChannel = item.closeChallengers.length
            ?
            item.newCapacity + +item.closeChallengers[0].channel.capacity < options.threshold
            :
            false

        if (command === 'open' && toOpenChannel) {
            let minimalAmnt = Math.round(item.newCapacity < options.minimalChannel ? options.minimalChannel : item.newCapacity)
            let data
            if (nodeAddresses[pubKey]) {
                // У неё есть IP address
                let where = Object.keys(nodeStorage.nodes).filter(val => ! (pendingChannelByNodeID[pubKey] && pendingChannelByNodeID[pubKey][val]))
                if (where.length)
                    data = {
                        command: 'openChannel',
                        where: where,
                        pubKey: pubKey,
                        address: nodeAddresses[pubKey],
                        amount: minimalAmnt
                    }
            }
            else if (connectionNodes[pubKey]) {
                data = {
                    command: 'openChannel',
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
                channelCommands.push(data)

            }
        }
        else if (command === 'close' && toCloseChannel) {
            // В первую очередь закрываем большие каналы
            let reduceAmount = options.threshold - item.newCapacity

            debug("Закрытие канала с узлом (%s), opts: %o", pubKey, item)
            item
                .closeChallengers
                .sort((a, b) => b.channel.local_balance - a.channel.local_balance)
                .reduce(
                    (acc, val) => {
                        if (acc > 0 && (maxBTC === undefined || maxBTC > 0)) {
                            acc        -= +val.channel.capacity
                            willBeFree += +val.channel.capacity
                            if (maxBTC !== undefined)
                                maxBTC -= +val.channel.capacity / 100000000
                            let data = {
                                key:     val.key,
                                command: 'closeChannel',
                                channel: val.channel
                            }
                            debug("Будет закрытие канала, команда: %o", data)
                            channelCommands.push(data)
                        }
                        return acc
                    },
                    reduceAmount
                )
        }
    }

    channelCommands = _.shuffle(channelCommands)

    if (command === 'close')
        console.log('Потенциально для освобождения: %d BTC', willBeFree / 100000000)
    else if (command === 'open')
        console.log("Будет открыто %d каналов на сумму: %d BTC", channelCommands.length, channelCommands.reduce((acc,val) => {return acc + val.amount}, 0)/1E8)

    for (let item of channelCommands) {
        debug("Команда для канала %o", item)
        if (options.dryRun)
            yield Promise.resolve(1)
        else
            yield makeCommandForChannel(item)
    }
}

async function openNewChannels() {
    // The number of promises to process simultaneously.
    let concurrency = 100

    // Create a pool.
    let pool = new PromisePool(commandChannelPromise(), concurrency)

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

async function makeCommandForChannel(command) {
    if (command.command === 'openChannel')
        openChannelCommand(command)
    else if (command.command === 'closeChannel')
        closeChannelCommand(command)
}

async function closeChannelCommand({key, channel}) {
    let channelPoint = /^(.*):(\d+)$/.exec(channel.channel_point)
    if (! channelPoint)
        throw new Error('channelPoint is not defined (%o)', channel)

    console.log('Закрываем канал (@%s) %s', key, channel.channel_point)
    let data = {
        channel_point: {
            funding_txid_str: channelPoint[1],
            funding_txid: 'funding_txid_str',
            output_index:     Number(channelPoint[2])
        },
        force: ! ! options.forced
    }
    if (! options.forced)
        data.target_conf = 36
    debug('Закрытие канана: item: %o, data: %o', channel, data)

    if (! options.dryRun) {
        return new Promise((resolve, reject) => {
            let stream = nodeStorage.nodes[key].client.closeChannel(data)
            stream.on('data', data => {
                debug("data of channel %o: %o", channel, data)
                if (data.update === 'close_pending' || data.update === 'chan_close') {
                    debug('Вызов cancel, %o', channel)
                    stream.cancel()
                }
            })
            stream.on('end', () => {
                debug("end event, resolve %s", resolve ? resolve.name : 'is null')
                if (resolve)
                    resolve(3)
            })
            stream.on('error', (e) => {
                debug('error event, error = %o', e)
                if (e.code === grpc.status.CANCELLED) {
                    debug('error: canceled')
                    resolve(2)
                }
                else {
                    reject(e)
                }

            })
        })
    }
    else
        console.log("Псевдозакрытие канала, %o", data)
}

async function openChannelCommand({pubKey, where, address, amount}) {
    let myNode
    for (let whereOpen of _.shuffle(where)) {
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
                            local_funding_amount: amount,
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
                    console.log("Канал (%s <--> %s / %d sats) успешно открыт!", whereOpen, pubKey, amount)
                    return res
                }
                catch (e) {
                    let res, minReq = false

                    if ((res = /chan size of ([\d.]+) BTC is below min chan size of ([\d.]+) BTC/.exec(e.message)) !== null) {
                        amount = Math.round(Number(res[2]) * 100000000)
                        minReq = true
                    }
                    else if ((res = /invalid funding_satoshis=(\d+) \(min=(\d+) max=(\d+)\)/.exec(e.message))) {
                        amount = Math.round(Number(res[2]))
                        minReq = true
                    }
                    else if ((res = /Promise timed out after \d+ milliseconds/.exec(e.message))) {
                        return null
                    }

                    if (minReq) {
                        // Удалённый узел требует минимального размера канала - пробуем удовлетворить его просьбу
                        console.log("Удалённый узел требует минимального размера канала (%d BTC) - пробуем удовлетворить его просьбу", amount / 100000000)
                        if (amount > MAX_CHAN_VALUE)
                            amount = MAX_CHAN_VALUE
                        try {
                            let res = await pTimeout(
                                myNode.client.openChannelSync({
                                    //node_pubkey: Buffer.from(pubKey, 'hex'),
                                    node_pubkey_string: pubKey,
                                    local_funding_amount: amount,
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
                            console.log("Канал (%s <--> %s / %d sats) успешно открыт!", whereOpen, pubKey, amount)
                            return res
                        }
                        catch (e) {
                            console.log("openChannelWithNodes(%s): ошибка (%s) открытия канала (коннект есть), возможно кончились средства (%s)", pubKey, e.message, whereOpen)
                            continue
                        }
                    }
                    else if (address === null && (res = /not enough witness outputs to create funding transaction, need ([\d.]+) BTC only have ([\d.]+) BTC/.exec(e.message)) !== null) {
                        // У нас есть коннект с этой нодой без публичного IP на этом сервере, но при этом у нас не хватает средств - пробуем открыть меньший канал
                        let amount = Math.round(Number(res[2]) * 100000000 - 50000)
                        if (amount > MAX_CHAN_VALUE)
                            amount = MAX_CHAN_VALUE
                        if (amount >= options.threshold) {
                            // Открываем только если мы имеем минимум для канала
                            try {
                                let res = await pTimeout(
                                    myNode.client.openChannelSync({
                                        //node_pubkey: Buffer.from(pubKey, 'hex'),
                                        node_pubkey_string: pubKey,
                                        local_funding_amount: amount,
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
                                console.log("Канал (%s <--> %s / %d sats) успешно открыт!", whereOpen, pubKey, amount)
                                return res
                            }
                            catch (e) {
                                console.log("openChannelWithNodes(%s): ошибка (%s) открытия канала (коннект есть), возможно кончились средства (%s)", pubKey, e.message, whereOpen)
                                continue
                            }
                        }
                        else {
                            console.log("Мы имеем коннект с узлом (%s <--> %s), который не имеет публичного IP, но не можем открыть канал - недостаточно средств (%d sats) для минимума канала", pubKey, whereOpen, amount)
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
