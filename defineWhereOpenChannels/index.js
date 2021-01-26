/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

// Должен быть первым - загружает переменные
require('dotenv').config()

let listChannels = require('../lib/listChannels')
let pendingChannels = require('../lib/pendingChannels')
let describeGraph = require('../lib/describeGraph')
let walletBalance = require('../lib/walletBalance')
var PromisePool = require('es6-promise-pool')

const CHANNEL_CAPACITY = 2000000;

process.umask(0o77);

const nodeStorage = require('../global/nodeStorage');

const debug = require('debug')('lnbig:dwoc')

let
    openNodes = {},
    noConnectNodes = {},
    byNodeID = {},
    edges = {};

let
    amntNodesWithChannels = 0,
    amntNodesWithoutChannels = 0,
    amntNodesWithChannelsNoAddr = 0,
    amntOnionNodes = 0,
    amntIP6Nodes = 0;

let $listChannels, $pendingChannels, $describeGraph, $walletBalance


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

    // To connect to nodes
    await nodeStorage.connect();

    debug('Запускаются асинхронные команды listChannels, pendingChannels, ...')
    $listChannels = listChannels(nodeStorage)
    $pendingChannels = pendingChannels(nodeStorage)
    $describeGraph = describeGraph(nodeStorage)
    $walletBalance = walletBalance(nodeStorage)

    debug('Ожидается завершение асинхронных команд listChannels, pendingChannels, ...')

    $listChannels = await $listChannels
    $pendingChannels = await $pendingChannels
    $describeGraph  = await $describeGraph
    $walletBalance = await $walletBalance

    debug('Данные получены полностью, обработка')

    for (let key in nodeStorage.nodes) {
        if (nodeStorage.nodes[key].client)
            calculateByNodeID($listChannels[key], $pendingChannels[key])
    }

    console.log("Количество нод, с которыми есть каналы где либо: %d", Object.keys(byNodeID).length)

    for (let key in nodeStorage.nodes) {
        if (nodeStorage.nodes[key].client) {
            calculateEdges($describeGraph[key]);
        }
    }

    console.log("Количество нод, с которыми у нас нет канала, но у них есть другие каналы: %d", amntNodesWithChannels);
    console.log("Количество нод onion, с которыми у нас нет канала, но у них есть другие каналы: %d", amntOnionNodes);
    console.log("Количество нод IP6, с которыми у нас нет канала, но у них есть другие каналы: %d", amntIP6Nodes);
    console.log("Количество нод без IP, с которыми у нас нет канала, но у них есть другие каналы: %d", amntNodesWithChannelsNoAddr);
    console.log("Количество нод, с которыми у нас нет канала, но и у них нет каналов: %d", amntNodesWithoutChannels);

    await createChannels()
}

function* nodesForOpening() {
    let randNodes = Object.keys(openNodes).map(val => {
        return {rand: Math.random(), key: val}
    }).sort((a, b) => a.rand - b.rand).map(val => val.key)

    let amnt = CHANNEL_CAPACITY;

    for (let pubKey of randNodes) {
        let bigWallets = Object.keys($walletBalance)
            .filter( val => { return $walletBalance[val].total_balance >= (amnt + 1000) })
            .map(val => { return { rand: Math.random(), val: val} })
            .sort((a, b) => a.rand - b.rand)
            .map( val => val.val )

        if (bigWallets.length == 0) {
            console.log("Кончились средства во всех каналах")
            break
        }

        debug("Сортировка нод по балансам, выбран: #1: %s (%d)",
            bigWallets[0],
            $walletBalance[bigWallets[0]].total_balance,
        )
        $walletBalance[bigWallets[0]].total_balance -= amnt + 1000
        yield openChannelWithNode(pubKey, bigWallets[0], amnt);
    }
}

async function createChannels() {
    // The number of promises to process simultaneously.
    let concurrency = 100

    // Create a pool.
    let pool = new PromisePool(nodesForOpening(), concurrency)

    pool.addEventListener('fulfilled', function (event) {
        // The event contains:
        // - target:    the PromisePool itself
        // - data:
        //   - promise: the Promise that got fulfilled
        //   - result:  the result of that Promise
        console.log('Открытие канала: result: %o', event.data.result)
    })

    pool.addEventListener('rejected', function (event) {
        // The event contains:
        // - target:    the PromisePool itself
        // - data:
        //   - promise: the Promise that got rejected
        //   - error:   the Error for the rejection
        console.log('Открытие канала - ОШИБКА: error: %o: ', event.data.error.message)
    })

    console.log(`Запускается создание каналов (в параллель: ${concurrency})`)

    // Start the pool.
    let poolPromise = pool.start()

    // Wait for the pool to settle.
    await poolPromise
    console.log('Всё завершено успешно')
}

async function openChannelWithNode(pubKey, whereOpen, amnt = CHANNEL_CAPACITY) {
    let myNode
    try {
        if (! openNodes.hasOwnProperty(pubKey))
            throw Error(`openChannelWithNode(${pubKey}): openNodes не имеет такого pubKey`)

        myNode = nodeStorage.nodes[whereOpen]

        let connected = false
        try {
            let connect_res = await myNode.client.connectPeer({addr: {pubkey: pubKey, host: openNodes[pubKey].address}, perm: false})
            debug("openChannelWithNode(%s): результат коннекта канала: %o", pubKey, connect_res)
            connected = true
        }
        catch (e) {
            console.log("openChannelWithNode(%s): коннект (%s) НЕУДАЧЕН - игнорирует эту ноду...", pubKey, openNodes[pubKey].address)
        }

        if (connected) {
            try {
                let res = await myNode.client.openChannelSync({
                    //node_pubkey: Buffer.from(pubKey, 'hex'),
                    node_pubkey_string: pubKey,
                    local_funding_amount: amnt,
                    push_sat: 0,
                    sat_per_byte: 1,
                    private: false,
                    min_htlc_msat: 10,
                    min_confs: 0,
                    spend_unconfirmed: true
                })
                debug("openChannelWithNode(%s): результат открытия канала: %o", pubKey, res)
                delete openNodes[pubKey]
                return res;
            }
            catch (e) {
                debug("openChannelWithNode(%s): ошибка (%s) открытия канала (коннект есть), возможно кончились средства (%s)", pubKey, e.message, whereOpen)
                return null
            }
        }
        else {
            $walletBalance[whereOpen].total_balance += amnt + 1000
            delete openNodes[pubKey]
            return null
        }
    }
    catch (e) {
        $walletBalance[whereOpen].total_balance += amnt + 1000
        console.log("Пойманная ошибка openChannelWithNode(%s) @ %s: %o", pubKey, myNode.key, e)
        throw Error(`Ошибка openChannelWithNode(${pubKey}): ${e.message}, ${e.stack}`)
    }
}

function calculateEdges(describeGraph) {
    for(let edge of describeGraph.edges) {
        edges[edge.node1_pub] = 1
        edges[edge.node2_pub] = 1
    }

    for(let node of describeGraph.nodes) {
        if (   ! openNodes.hasOwnProperty(node.pub_key)
            && ! byNodeID.hasOwnProperty(node.pub_key)
            && ! noConnectNodes.hasOwnProperty(node.pub_key))
        {
            if (edges.hasOwnProperty(node.pub_key)) {
                // Этой ноды нет, а каналы у неё есть - добавляем в массив
                let addr =  node.addresses.filter( val => val.network == 'tcp' && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(val.addr) )[0]
                if (addr) {
                    amntNodesWithChannels++;
                    openNodes[node.pub_key] = { pubKey: node.pub_key, address: addr.addr}
                }
                else {
                    if ( node.addresses.filter( val => val.network == 'tcp' && /\.onion:\d+$/.test(val.addr)).length )
                        amntOnionNodes++
                    if ( node.addresses.filter( val => val.network == 'tcp' && /^\[[\w:]+\]:\d+$/.test(val.addr)).length )
                        amntIP6Nodes++
                    amntNodesWithChannelsNoAddr++
                    noConnectNodes[node.pub_key] = 1

                }
            }
            else {
                amntNodesWithoutChannels++
            }
        }
    }
}

function calculateByNodeID(listChannels, pendingChannels) {
    let channel

    for (channel of listChannels.channels) {
        if (channel.local_balance >= CHANNEL_CAPACITY * 0.8)
            byNodeID[channel.remote_pubkey] = 1
    }

    for (channel of pendingChannels.pending_open_channels) {
        if (channel.channel.local_balance >= CHANNEL_CAPACITY * 0.8)
            byNodeID[channel.channel.remote_node_pub] = 1
    }

    for (channel of pendingChannels.pending_closing_channels) {
        byNodeID[channel.channel.remote_node_pub] = 1
    }

    for (channel of pendingChannels.pending_force_closing_channels) {
        byNodeID[channel.channel.remote_node_pub] = 1
    }

    for (channel of pendingChannels.waiting_close_channels) {
        byNodeID[channel.channel.remote_node_pub] = 1
    }
}
