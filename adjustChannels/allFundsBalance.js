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

const listChannels = require('../lib/listChannels')
const pendingChannels = require('../lib/pendingChannels')
const walletBalance = require('../lib/walletBalance')
const closedChannels = require('../lib/closedChannels')
const forwardingHistory = require('../lib/forwardingHistory')
const getTransactions = require('../lib/getTransactions')

const BitcoinClient = require('bitcoin-core')
const bitcoinClient = new BitcoinClient({
    username: process.env.BITCOIND_USER,
    password: process.env.BITCOIND_PASS
})


process.umask(0o77);

const nodeStorage = require('../global/nodeStorage');

const debug = require('debug')('lnbig:dwoc')

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
    .option('-t, --threshold <n>', 'Проходная величина для открытия канала', (str, def) => parseInt(str || def), 6000000)
    .option('-m, --minimal-channel <n>', 'Минимальная величина открываемого канала', (str, def) => parseInt(str || def), 3000000)
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
    $pendingChannels = pendingChannels(nodeStorage)
    $walletBalance = walletBalance(nodeStorage)
    $closedChannels = closedChannels(nodeStorage, {remote_force: true})
    $forwardingHistory = forwardingHistory(nodeStorage)
    $getTransactions = getTransactions(nodeStorage)

    debug('Ожидается завершение асинхронных команд listChannels...')

    $listChannels = await $listChannels
    $pendingChannels = await $pendingChannels
    $walletBalance = await $walletBalance
    $closedChannels = await $closedChannels
    $forwardingHistory = await $forwardingHistory
    $getTransactions = await $getTransactions

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
                    fee: 0,
                },
            }

            let ourTx = {}

            for (let tx of $getTransactions[key].transactions) {
                ourTx[tx.tx_hash] = tx
            }

            debug("Наши транзакции (%s): %o", key, ourTx)

            let chanStats = {}

            for (let channel of $closedChannels[key].channels) {
                if (channel.chan_id === "0")
                    continue
                let item = chanStats[channel.chan_id] = {}
                item.channel = channel
                item.initiator = false
                item.capacity = +channel.capacity
                let tx = /^(.*):(\d+)$/.exec(channel.channel_point)
                if (tx[1] && ourTx[tx[1]]) {
                    console.assert(+ourTx[tx[1]].amount < 0, "Такого не должно быть (%s)! %s: %d", key, tx[1], +ourTx[tx[1]].amount)
                    debug("Канал открыли мы, chan_id: %s", channel.chan_id)
                    item.initiator = true
                    item.localBalance = item.capacity
                    item.remoteBalance = 0
                }
                else {
                    item.remoteBalance = item.capacity
                    item.localBalance = 0
                }
            }

            for (let payment of $forwardingHistory[key].forwarding_events) {
                if (chanStats[payment.chan_id_in]) {
                    chanStats[payment.chan_id_in].localBalance  += +payment.amt_in
                    chanStats[payment.chan_id_in].remoteBalance -= +payment.amt_in
                }
                if (chanStats[payment.chan_id_out]) {
                    chanStats[payment.chan_id_out].remoteBalance += +payment.amt_out
                    chanStats[payment.chan_id_out].localBalance  -= +payment.amt_out
                }
            }

            debug("Статистика (%s) chanStats: %o", key, chanStats)

            // Теперь ищём каналы breach
            for (let chanId in chanStats) {
                let item = chanStats[chanId]

                if (item.localBalance > 0 && +item.channel.settled_balance === 0) {
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
            }

            // Считаем средства в pending каналах
            for (let type of ['pending_open_channels', 'pending_closing_channels', 'pending_force_closing_channels', 'waiting_close_channels']) {
                for (item of $pendingChannels[key][type]) {
                    let channel = item.channel
                    let channelPoint = /^(.*):(\d+)$/.exec(channel.channel_point)

                    switch (type) {
                        case 'pending_open_channels':
                            if (channelPoint && await checkTx(channelPoint[1], channelPoint[2])) {
                                stat.pending.open += +channel.local_balance
                                stat.pending.fee  += +channel.local_balance > 0 ? +item.commit_fee : 0
                            }
                            else {
                                debug('notValidTx/pending_open_channels: %s', channel.channel_point)
                                stat.pending.notValidTx++
                            }
                            break
                        case 'pending_closing_channels':
                            stat.pending.closing += +channel.local_balance
                            debug("pending_closing_channels: checkTx: %d", channelPoint && await checkTx(channelPoint[1], channelPoint[2]))
                            break
                        case 'pending_force_closing_channels':
                            stat.pending.forceClosing += +item.limbo_balance
                            //stat.pending.forceClosing += +channel.local_balance
                            debug("pending_force_closing_channels: checkTx: %d", channelPoint && await checkTx(channelPoint[1], channelPoint[2]))
                            break
                        case 'waiting_close_channels':
                            debug("waiting_close_channels: checkTx: %d", channelPoint && await checkTx(channelPoint[1], channelPoint[2]))
                            if (channelPoint && await checkTx(channelPoint[1], channelPoint[2])) {
                                stat.pending.waitClose += +item.limbo_balance
                                //stat.pending.waitClose += +channel.local_balance
                            }
                            else {
                                debug('notValidTx/waiting_close_channels: %s', channel.channel_point)
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
            + stat.feeInChannels
            + stat.pending.fee
        ) / 1E8

        console.log("Узел %s\n  %d BTC", key, amnt)
        all += amnt
        byTypes.wallet += stat.wallet
        byTypes.inChannels += stat.inChannels
        byTypes.pending.open += stat.pending.open
        byTypes.pending.closing += stat.pending.closing
        byTypes.pending.forceClosing += stat.pending.forceClosing
        byTypes.pending.waitClose += stat.pending.waitClose
        byTypes.feeInChannels += stat.feeInChannels
        byTypes.pending.fee += stat.pending.fee
    }
    console.log(
`Сумма: %d BTC
Детально:
  Wallet ..............: %d BTC
  В каналах ...........: %d BTC
  Pending open ........: %d BTC
  Pending closing .....: %d BTC
  Pending force closing: %d BTC
  Pending wait close ..: %d BTC
  Pending fee .........: -%d BTC
  Fee в каналах .......: -%d BTC`,
        all,
        byTypes.wallet / 1E8,
        byTypes.inChannels / 1E8,
        byTypes.pending.open / 1E8,
        byTypes.pending.closing / 1E8,
        byTypes.pending.forceClosing / 1E8,
        byTypes.pending.waitClose / 1E8,
        byTypes.pending.fee / 1E8,
        byTypes.feeInChannels / 1E8,
    )

}

async function checkTx(hash, index) {
    debug("Проверяем транзакцию: %s / %d", hash, index)
    let res = await bitcoinClient.getTxOut(hash, +index, true)
    debug("Результат проверки: %o", res)
    return ! ! (res && res.confirmations >= 0)
}
