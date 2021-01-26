/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const PromisePool = require('es6-promise-pool')
const _ = require('lodash')
const nodeStorage = require('../global/nodeStorage');
const { myNodes } = require('../global/myNodes')
const { MAX_SATOSHIS_PER_TRANSACTION } = require('./constants')

const listChannels = require('../lib/listChannels')
const getInfo  = require('../lib/getInfo')
const debug = require('debug')('lnbig:rebalanceOurNodes')
let program = require('commander')
let options

let $listChannels,
    $getInfo,
    successfulAmountOurRebalanced = 0,
    errorAmountOurRebalanced = 0

function* promiseGenerator() {
    // Проходим по каналам и собираем информацию для корректировки
    let rebalanceCommands = []

    for (let key in nodeStorage.nodes) {
        if (nodeStorage.nodes[key].client)
            findChannelsBetweenOurNodes(key, rebalanceCommands)
    }

    for (let command of _.shuffle(rebalanceCommands)) {
        yield rebalanceOneChannelBetweetOurNodes(command)
    }
}

async function rebalanceOneChannelBetweetOurNodes(command) {
    if (! program.dryRun) {
        debug(`rebalanceOneChannel: начало ребаланса канала, команда: %o`, command)
        let res = await nodeStorage.nodes[command.invoiceFrom.key].client.addInvoice({
            memo: `Rebalance from ${command.payWho.key} to ${command.invoiceFrom.key} ${command.amount} sats through ${command.chanId} channel`,
            value: command.amount,
        })
        command.decodedPayReq = await nodeStorage.nodes[command.payWho.key].client.decodePayReq({pay_req: res.payment_request})
        debug("Результат создания инвойса: %o (команда %o)", res, command)
        let resPayment = await nodeStorage.nodes[command.payWho.key].client.sendPaymentSync({
            dest_string:         command.decodedPayReq.destination,
            payment_hash_string: command.decodedPayReq.payment_hash,
            amt:                 command.decodedPayReq.num_satoshis,
            final_cltv_delta:    command.decodedPayReq.cltv_expiry,
            fee_limit:           {fixed: 0},
            outgoing_chan_id:    command.chanId,
        })
        debug("Результат оплаты канала: %o", resPayment)
        if (resPayment.payment_error !== '') {
            console.warn("Ошибка оплаты инвойса: %o", resPayment)
            errorAmountOurRebalanced++
        }
        else
            successfulAmountOurRebalanced++
    }
    else {
        console.log(`Эмуляция ребалансировки канала: from ${command.payWho.key} to ${command.invoiceFrom.key} ${command.amount} sats through ${command.chanId} channel`)
    }
}

module.exports = async function (opts = {}) {
    // The number of promises to process simultaneously.
    options = opts
    $listChannels = listChannels(nodeStorage, {active_only: true})
    $getInfo = getInfo(nodeStorage)
    debug('Запускаются асинхронные команды...')
    $listChannels = await $listChannels
    $getInfo = await $getInfo
    debug('Данные получены полностью, обработка')

    let concurrency = 100

    // Create a pool.
    let pool = new PromisePool(promiseGenerator(), concurrency)

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
        console.log('promiseGenerator: ОШИБКА: error: %o: ', event.data.error.message)
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

