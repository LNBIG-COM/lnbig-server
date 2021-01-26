/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

// To see algorithm here: https://gist.github.com/LNBIG-COM/dfe5d25bcea25612c559e02fd7698660
// In this file there are many debugging info now. And russian-language comments for me

// Должен быть первым - загружает переменные
require('dotenv').config()
let program = require('commander')

const listChannels = require('../lib/listChannels')
const pendingChannels = require('../lib/pendingChannels')
const walletBalance = require('../lib/walletBalance')
const closedChannels = require('../lib/closedChannels')
const forwardingHistory = require('../lib/forwardingHistory')
const getTransactions = require('../lib/getTransactions')
const { checkTx, splitChannelPoint } = require('../lib/utilChannels')
const stringify = require('json-stringify-deterministic')
const util = require('util')
const fs = require('fs')
const appendFile = util.promisify(fs.appendFile)

// If localBalance < this value - we ignore it case
const BREACH_SATS_LIMIT = 1100

// From this block i had last self-breach case
const BREACH_BLOCK_START = 576294

process.umask(0o77);

const nodeStorage = require('../global/nodeStorage');

const debug = require('debug')('lnbig:allFundBalance')

let
    myNodes = {}

let $listChannels,
    $pendingChannels,
    $walletBalance,
    $closedChannels,
    $forwardingHistory,
    $getTransactions,
    stats = {}

program
    .version('0.1.0')

program
    .option('-t, --threshold <n>', 'Проходная величина для открытия канала', (str, def) => parseInt(str || def, 10), 6000000)
    .option('-m, --minimal-channel <n>', 'Минимальная величина открываемого канала', (str, def) => parseInt(str || def, 10), 3000000)
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

function cleanDataFromVar(data) {
    for (let key in data.$listChannels) {
        data.$listChannels[key].channels.forEach(
            (channel) => {
                if (channel.initiator) {
                    channel.local_balance_bruto  = +channel.local_balance + +channel.commit_fee
                    channel.remote_balance_bruto = +channel.remote_balance
                }
                else {
                    channel.local_balance_bruto  = +channel.local_balance
                    channel.remote_balance_bruto = +channel.remote_balance  + +channel.commit_fee
                }
                delete channel.local_balance
                delete channel.remote_balance
                delete channel.commit_fee
                delete channel.fee_per_kw
                delete channel.num_updates
            }
        )
        data.$pendingChannels[key].pending_force_closing_channels.forEach(
            (item) => {
                item.pending_htlcs.forEach((item) => {delete item.blocks_til_maturity})
                delete item.blocks_til_maturity
            }
        )
        data.$pendingChannels[key].pending_open_channels.forEach(
            (item) => {
                delete item.commit_fee
                delete item.fee_per_kw
                delete item.confirmation_height
            }
        )
        data.$getTransactions[key].transactions.forEach(
            (item) => {
                delete item.num_confirmations
            }
        )
    }
    return data
}

async function _main(password) {
    // To create object for node storage

    // load node storage data included crypted macaroon files, and decrypt macaroon files by password. After the password to be cleaned from memory
    await nodeStorage.init(require('../global/nodesInfo'), password);
    let key

    for (key in nodeStorage.nodes)
        myNodes[nodeStorage.nodes[key].pubKey] = key

    debug("Мои ноды: %o", myNodes)
    //await fs.mkdir('./balances')

    // To connect to nodes
    await nodeStorage.connect({longsAsNumbers: false});

    debug('Запускаются асинхронные команды listChannels...')

    $listChannels = listChannels(nodeStorage)
    $pendingChannels = pendingChannels(nodeStorage)
    $walletBalance = walletBalance(nodeStorage)
    $closedChannels = closedChannels(nodeStorage, {remote_force: true})
    $forwardingHistory = forwardingHistory(nodeStorage, {start_time: 0, num_max_events: 0x7FFFFFFF})
    $getTransactions = getTransactions(nodeStorage)

    debug('Ожидается завершение асинхронных команд listChannels...')

    $listChannels = await $listChannels
    $pendingChannels = await $pendingChannels
    $walletBalance = await $walletBalance
    $closedChannels = await $closedChannels
    $forwardingHistory = await $forwardingHistory
    $getTransactions = await $getTransactions

    let file = `./balances/${(new Date()).toISOString()}.txt`
    debug(`Формируем файл ${file}`)
    await appendFile(
        file,
        stringify(
            cleanDataFromVar({
                    $listChannels:      JSON.parse(JSON.stringify($listChannels)),
                    $pendingChannels:   JSON.parse(JSON.stringify($pendingChannels)),
                    $walletBalance:     JSON.parse(JSON.stringify($walletBalance)),
                    $closedChannels:    JSON.parse(JSON.stringify($closedChannels)),
                    $forwardingHistory: JSON.parse(JSON.stringify($forwardingHistory)),
                    $getTransactions:   JSON.parse(JSON.stringify($getTransactions)),
                }),
            {space: '  '}
        ),
        'utf8'
    )
    debug(`Формируем файл ${file}`)

    debug('Данные получены полностью, обработка')

    let item

    for (key in nodeStorage.nodes) {
        if (nodeStorage.nodes[key].client) {
            let stat = stats[key] = {
                wallet: 0,
                inChannels: 0,
                feeInChannels: 0,
                pending: {
                    open: 0,
                    openNotValidSats: 0,
                    closing: 0,
                    forceClosing: 0,
                    waitClose: 0,
                    notValidTx: 0,
                    compensationHtlc: 0,
                    fee: 0,
                    channels: [],
                },
                pendingNotValid: {
                    channels: []
                }
            }

            let ourTx = {}

            for (let tx of $getTransactions[key].transactions) {
                ourTx[tx.tx_hash] = tx
            }

            // debug("Наши транзакции (%s): %o", key, ourTx)

            let chanStats = {}

            for (let channel of $closedChannels[key].channels) {
                if (channel.chan_id === "0")
                    continue
                let item = chanStats[channel.chan_id] = {}
                item.channel = channel
                item.initiator = false
                item.capacity = +channel.capacity
                let {hash} = splitChannelPoint(channel.channel_point)
                if (ourTx[hash] && +ourTx[hash].amount < 0) {
                    debug("Канал открыли мы, chan_id: %s", channel.chan_id)
                    item.initiator = true
                    item.localBalance = item.capacity
                    item.remoteBalance = 0
                }
                else {
                    if (ourTx[hash] && +ourTx[hash].amount >= 0)
                        console.warn("Сумма channel_point закрытого канала должна быть меньше ноля, а она больше или равна (node %s), tx: %s, amount:%d", key, hash, +ourTx[hash].amount)
                    else {
                        item.remoteBalance = item.capacity
                        item.localBalance = 0
                    }
                }
            }

            console.log('The number of forwardingHistory of %s is: %d', key, $forwardingHistory[key].forwarding_events.length)
            for (let payment of $forwardingHistory[key].forwarding_events) {
                if (chanStats[payment.chan_id_in]) {
                    chanStats[payment.chan_id_in].tnxs = chanStats[payment.chan_id_in].tnxs || []
                    chanStats[payment.chan_id_in].tnxs.push(payment)
                    chanStats[payment.chan_id_in].localBalance  += +payment.amt_in
                    chanStats[payment.chan_id_in].remoteBalance -= +payment.amt_in
                }
                if (chanStats[payment.chan_id_out]) {
                    chanStats[payment.chan_id_out].tnxs = chanStats[payment.chan_id_out].tnxs || []
                    chanStats[payment.chan_id_out].tnxs.push(payment)
                    chanStats[payment.chan_id_out].remoteBalance += +payment.amt_out
                    chanStats[payment.chan_id_out].localBalance  -= +payment.amt_out
                }
            }

            debug("Статистика (%s) chanStats: %o", key, chanStats)

            // Теперь ищём каналы breach
            for (let chanId in chanStats) {
                let item = chanStats[chanId]

                if (item.localBalance > BREACH_SATS_LIMIT && +item.channel.settled_balance === 0 && item.channel.close_height > BREACH_BLOCK_START) {
                    // Возможно этот случай breach
                    console.warn("Возможно случай self breach (node %s): %o", item, key)
                }
            }

            stat.wallet += +$walletBalance[key].total_balance

            // Считаем средства в каналах
            for (item of $listChannels[key].channels) {
                stat.inChannels += +item.local_balance
                if (item.initiator)
                    stat.feeInChannels += +item.commit_fee
                if (item.pending_htlcs.length>0) {
                    stat.pending.compensationHtlc += item.pending_htlcs.reduce((a, v) => { return a + (v.incoming ? -v.amount : +v.amount)}, 0)
                    console.log("Сервер %s, канал %s, sum: %d, pending платежи: %o", key, item.chan_id, stat.pending.compensationHtlc, item.pending_htlcs)
                }
            }

            // Считаем средства в pending каналах
            for (let type of ['pending_open_channels', 'pending_closing_channels', 'pending_force_closing_channels', 'waiting_close_channels']) {
                for (item of $pendingChannels[key][type]) {
                    let channel = item.channel
                    let {hash, index} = splitChannelPoint(channel.channel_point)

                    switch (type) {
                        case 'pending_open_channels':
                            if (await checkTx(hash, index)) {
                                stat.pending.channels.push({key, type, item})
                                stat.pending.open += +channel.local_balance
                                stat.pending.fee  += +channel.local_balance > 0 ? +item.commit_fee : 0
                            }
                            else {
                                stat.pendingNotValid.channels.push({key, type, item, hash, index})
                                stat.pending.notValidTx++
                            }
                            break
                        case 'pending_closing_channels':
                            if (await checkTx(hash, index)) {
                                stat.pending.channels.push({key, type, item})
                                stat.pending.closing += +channel.local_balance
                            }
                            else {
                                stat.pendingNotValid.channels.push({key, type, item, hash, index})
                                stat.pending.notValidTx++
                            }
                            break
                        case 'pending_force_closing_channels':
                            if (await checkTx(hash, index)) {
                                stat.pending.channels.push({key, type, item})
                                stat.pending.forceClosing += +item.limbo_balance
                                if (item.pending_htlcs.length > 0) {
                                    stat.pending.compensationHtlc += item.pending_htlcs.reduce((a, v) => { return a + (v.incoming ? -v.amount : +v.amount)}, 0)
                                    console.log(`${key}: pending_force_closing_channels/pending_htlcs: %o`, item.pending_htlcs)
                                }
                            }
                            else {
                                stat.pendingNotValid.channels.push({key, type, item, hash, index})
                                stat.pending.notValidTx++
                            }
                            break
                        case 'waiting_close_channels':
                            if (await checkTx(hash, index)) {
                                stat.pending.channels.push({key, type, item})
                                stat.pending.waitClose += +item.limbo_balance
                            }
                            else {
                                stat.pendingNotValid.channels.push({key, type, item, hash, index})
                                stat.pending.notValidTx++
                            }
                            break
                    }
                }
            }
        }
    }

    console.log("Статистика по узлам: %s", (new Date).toUTCString())

    let all = 0
    let byTypes = {
        wallet: 0,
        inChannels: 0,
        feeInChannels: 0,
        pending: {
            open: 0,
            openNotValidSats: 0,
            closing: 0,
            forceClosing: 0,
            waitClose: 0,
            notValidTx: 0,
            fee: 0,
            compensationHtlc: 0,
        }
    }

    debug('stats = %o', stats)

    for (key in stats) {
        let stat = stats[key]
        let amnt = (
            stat.inChannels
            + stat.wallet
            + stat.pending.open
            + stat.pending.closing
            + stat.pending.forceClosing
            + stat.pending.waitClose
            + stat.pending.compensationHtlc
        )

        console.log("-------------------------------------------------\nУзел %s\n  %d BTC", key, amnt / 1E8)
        all += amnt
        byTypes.wallet += stat.wallet
        byTypes.inChannels += stat.inChannels
        byTypes.pending.open += stat.pending.open
        byTypes.pending.closing += stat.pending.closing
        byTypes.pending.forceClosing += stat.pending.forceClosing
        byTypes.pending.waitClose += stat.pending.waitClose
        byTypes.feeInChannels += stat.feeInChannels
        byTypes.pending.compensationHtlc += stat.pending.compensationHtlc
        byTypes.pending.fee += stat.pending.fee
        byTypes.pending.notValidTx += stat.pending.notValidTx

        console.log("GOOD PENDING channels:\n%o", stat.pending)
        console.log("FAIL PENDING channels:\n%o", stat.pendingNotValid)
    }
    console.log(
`------------------------------------------------------------------
Потери на комиссиях:
  Pending fee .........: %d BTC
  Fee в каналах .......: %d BTC
  **********************
  Сумма потерь: %d BTC
  
Детально:
  Wallet ..............: %d BTC
  В каналах ...........: %d BTC
  Pending open ........: %d BTC
  Pending closing .....: %d BTC
  Pending force closing: %d BTC
  Pending wait close ..: %d BTC
  Pending HTLC sums ...: %d BTC
  ******************************
  Сумма: %d BTC`,
        byTypes.pending.fee / 1E8,
        byTypes.feeInChannels / 1E8,
        (byTypes.pending.fee + byTypes.feeInChannels) / 1E8,

        byTypes.wallet / 1E8,
        byTypes.inChannels / 1E8,
        byTypes.pending.open / 1E8,
        byTypes.pending.closing / 1E8,
        byTypes.pending.forceClosing / 1E8,
        byTypes.pending.waitClose / 1E8,
        byTypes.pending.compensationHtlc / 1E8,
        all / 1E8,
    )

}
