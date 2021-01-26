/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

// Должен быть первым - загружает переменные
require('dotenv').config()
let program = require('commander')
var PromisePool = require('es6-promise-pool')
var _ = require('lodash')
const pTimeout = require('p-timeout')
const SEND_PAYMENT_TIMEOUT = 10000
const grpc = require('grpc')

const listChannels = require('../lib/listChannels')
//const describeGraph = require('../lib/describeGraph')
const getInfo  = require('../lib/getInfo')

const MAX_SATOSHIS_PER_TRANSACTION = 4294967

process.umask(0o77);

const nodeStorage = require('../global/nodeStorage');

const debug = require('debug')('lnbig:paidRebalance')

let
    myNodes = {}

let $listChannels,
    //$describeGraph,
    $getInfo,
    successfulAmountOurRebalanced = 0,
    errorAmountOurRebalanced = 0

program
    .version('0.1.0')

program
    .option('--our-nodes', 'Ребаланс только между нашими узлами')
    .option('-n, --dry-run', 'Проверочный запуск без действий для открытия каналов')

program
    .parse(process.argv);

main()
    .then( () => {
        console.log("Все задачи выполнены")
        process.exit(0)
    })
    .catch( (e) => {
        console.error("ERROR: %s\n%s", e.message, e.stack)
        process.exit(1)
    })

async function main () {
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

    $listChannels = listChannels(nodeStorage)
    //$describeGraph = describeGraph(nodeStorage)
    $getInfo = getInfo(nodeStorage)

    debug('Ожидается завершение асинхронных команд listChannels...')

    $listChannels = await $listChannels
    //$describeGraph = await $describeGraph
    $getInfo = await $getInfo

    debug('Данные получены полностью, обработка')

    if (program.ourNodes) {
        await rebalanceBetweenOurNodes()
    }
}

function* rebalanceBetweenOurNodePromise() {
    // Проходим по каналам и собираем информацию для корректировки
    let rebalanceCommands = []

    for (let key in nodeStorage.nodes) {
        if (nodeStorage.nodes[key].client)
            findChannelsBetweenOurNodes(key, rebalanceCommands)
    }

    for (let command of _.shuffle(rebalanceCommands)) {
        yield rebalanceOneChannel(command)
    }
}

async function rebalanceOneChannel(command) {
    if (! program.dryRun) {
        debug(`rebalanceOneChannel: начало ребаланса канала, команда: %o`, command)
        let res = await nodeStorage.nodes[command.invoiceFrom.key].client.addInvoice({
            memo: `Rebalance from ${command.payWho.key} to ${command.invoiceFrom.key} ${command.amount} sats through ${command.chanId} channel`,
            value: command.amount,
        })
        command.decodedPayReq = await nodeStorage.nodes[command.payWho.key].client.decodePayReq({pay_req: res.payment_request})
        debug("Результат создания инвойса (%s->%s): %o (команда %o)", command.payWho.key, command.invoiceFrom.key, res, command)

        return pTimeout(
            new Promise((resolve) => {
/*
                let req = {
                    dest: Buffer.from(command.decodedPayReq.destination, 'hex'),
                    amt: command.decodedPayReq.num_satoshis,
                    payment_hash: Buffer.from(command.decodedPayReq.payment_hash, 'hex'),
                    final_cltv_delta: command.decodedPayReq.cltv_expiry,
                    payment_addr: command.decodedPayReq.payment_addr,
                    fee_limit_sat: 0,
                    outgoing_chan_ids: [command.chanId],
                    timeout_seconds: 9,
                }
*/

                let req = {
                    payment_request: res.payment_request,
                    fee_limit_sat: 0,
                    outgoing_chan_ids: [command.chanId],
                    timeout_seconds: 9,
                }

                debug("sendPaymentV2 (%s->%s) req: %o", command.payWho.key, command.invoiceFrom.key, req)

                let stream = nodeStorage.nodes[command.payWho.key].client.Router.sendPaymentV2(req)
                stream.on('data', data => {
                    debug("payment update (%s->%s) of channel, status=%s, data: %o", command.payWho.key, command.invoiceFrom.key, data.status, data)
                    if (data.status === 'SUCCEEDED' || data.status === 'FAILED') {
                        if (data.status === 'SUCCEEDED')
                            successfulAmountOurRebalanced++
                        else
                            errorAmountOurRebalanced++
                        stream.cancel()
                    }
                })
                stream.on('end', () => {
                    debug("end event, stream закрывается по canceled (%s->%s)", command.payWho.key, command.invoiceFrom.key)
                    if (resolve)
                        resolve(3)
                })
                stream.on('error', (e) => {
                    if (e.code === grpc.status.CANCELLED) {
                        debug("Всё OK - stream закрывается по canceled (%s->%s)", command.payWho.key, command.invoiceFrom.key)
                        resolve(2)
                    }
                    else {
                        debug("FAIL - stream закрывается по canceled (%s->%s), ошибка %s", command.payWho.key, command.invoiceFrom.key, e.message)
                        resolve(4)
                    }
                })
            }),
            SEND_PAYMENT_TIMEOUT
        ).catch( () => {} ) // Делаем promise всегда без ошибок - чтобы продолжалась работа пула
    }
    else {
        console.log(`Эмуляция ребалансировки канала: from ${command.payWho.key} to ${command.invoiceFrom.key} ${command.amount} sats through ${command.chanId} channel`)
    }
}

async function rebalanceBetweenOurNodes() {
    // The number of promises to process simultaneously.
    let concurrency = 100

    // Create a pool.
    let pool = new PromisePool(rebalanceBetweenOurNodePromise(), concurrency)

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
        console.log('rebalanceBetweenOurNodePromise: ОШИБКА: error: %o: ', event.data.error.message)
    })

    console.log(`Запускается в параллель: ${concurrency}`)

    // Start the pool.
    let poolPromise = pool.start()

    // Wait for the pool to settle.
    await poolPromise
    console.log(
`Всё завершено успешно
Количество успешно ребалансированных: ${successfulAmountOurRebalanced}
Количество неудачных: ${errorAmountOurRebalanced}`
    )
}

function findChannelsBetweenOurNodes(key1, rebalanceCommands) {
    let channel

    let listChannels = $listChannels[key1],
        //describeGraph = $describeGraph[key1],
        getInfo = $getInfo[key1]

    if (! getInfo.synced_to_chain) {
        console.warn(`Сервер ${key1} не синхронизирован с цепью - игнорируем его`)
        return
    }

    // Собираем статистику по каналам, которые уже есть и с теми условиями, с которыми нам надо
    // В данном случае - учитываем те каналы, где есть средства с нашей стороны
    let key2, localCommands = {}, command
    for (channel of listChannels.channels) {
        let lack = ((+channel.capacity -channel.commit_fee) / 2) - +channel.local_balance
        if ((key2 = myNodes[channel.remote_pubkey]) && key1 !== key2 && lack > 1000 ) {
            // Значит key1 - сторона для создания инвойса, а key2 - тот, кто платит
            rebalanceCommands.push(command = {
                invoiceFrom: {key: key1, pubKey: nodeStorage.nodes[key1].pubKey},
                payWho: {key: key2, pubKey: channel.remote_pubkey},
                amount: Math.round(Math.min(lack, MAX_SATOSHIS_PER_TRANSACTION)),
                chanId: channel.chan_id,
                capacity: +channel.capacity,
                //edge: null,
                blockHeight: getInfo.block_height,
                decodedPayReq: null
            })
            localCommands[command.chanId] = command
            debug("Команда ребаланса: %o", command)
        }
    }

    /*for (let edge of describeGraph.edges) {
        if (localCommands[edge.channel_id])
            localCommands[edge.channel_id].edge = edge
    }*/
}

