/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

// Должен быть первым - загружает переменные
require('dotenv').config()
var program = require('commander')

program
    .version('0.1.0')
    .option('-n, --dry-run', 'Запуск для получения статистики')
    .option('--cltv-changed', 'Если изменена CLTV в исходном тексте')
    .parse(process.argv);

let listChannels = require('../lib/listChannels')
let feeReport = require('../lib/feeReport')
let findBestFee = require('../lib/findBestFee')
const {splitChannelPoint} = require('../lib/utilChannels')

var PromisePool = require('es6-promise-pool')

const FOREIGN_DELTA_CLTV = 40

// Нижняя и верхние границы local_balance части, в пределах которых мы считаем баланс сбалансированным

// >= этой границы канал считаем сбалансированным
const LOWER_LOCAL_BALANCE = 0.3

// Если дошли до <= этого значения - включаем ограничивающие fee
const LOWER_LOCAL_BALANCE_CHANGE_FEE = 0.35

// <= границы считаем канал сбалансированным
const UPPER_LOCAL_BALANCE = 0.6

const PAYMENT_AVERAGE = 60000
const PAYMENT_BIGGEST = 4000000

const FEE_DENOMINATOR = 1000000

// Целевое значение fee %, к которому мы стремимся
// РЕДАКТИРОВАТЬ ЭТОТ ПАРАМЕТР, если что
const TARGET_FEE_MARKET = 7000

// Комиссия между нашими узлами
const TARGET_FEE_OUR_NODE = 0

// Целевое значение, которого мы стремимся придерживаться для нормальных каналов.
// Здесь учтена поправка, если платёж прошёл хотя бы через один канал между нашими нодами
const TARGET_FEE_BALANCED = TARGET_FEE_MARKET

// Для каналов, которые истощились - высокая комиссия
//const TARGET_FEE_STOP = Math.round(TARGET_FEE_MARKET * 2)
const TARGET_FEE_STOP = Math.round(TARGET_FEE_MARKET * 1)

// Для каналов, которые хотим сбалансировать
//const TARGET_FEE_CHEAP = Math.round(TARGET_FEE_MARKET * 0.5)
const TARGET_FEE_CHEAP = Math.round(TARGET_FEE_MARKET * 1)

// Комиссия для частных каналов
//const TARGET_FEE_PRIVATE =  Math.round(TARGET_FEE_MARKET * 3)
const TARGET_FEE_PRIVATE =  Math.round(TARGET_FEE_MARKET * 1)

// Каналы между моими нодами
const LOCAL_DELTA_CLTV   = 18

process.umask(0o77);

const nodeStorage = require('../global/nodeStorage');

const debug = require('debug')('lnbig:smart-rebalance')

let
    myNodes = {};

let $listChannels,
    $feeReport,
    amntMyChannels = 0,
    amntUnbalancedUpperLocalBalanceChannels = 0, // if remote_balance < 10% - cheapest fees
    amntUnbalancedLowerLocalBalanceChannels = 0,  // if local_balance <= 10% - bigest fees
    amntBalancedChannels = 0,
    amntBadChannels = 0,
    amntPrivateChannels = 0,
    sumRemoteBalance = 0,
    sumLocalBalance = 0,
    sumForRebalance = 0

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

    try {
        // load node storage data included crypted macaroon files, and decrypt macaroon files by password. After the password to be cleaned from memory
        await nodeStorage.init(require('../global/nodesInfo'), password);

        for (let key in nodeStorage.nodes)
            myNodes[nodeStorage.nodes[key].pubKey] = key

        debug("Мои ноды: %o", myNodes)

        // To connect to nodes
        await nodeStorage.connect({longsAsNumbers: true});

        debug('Запускаются асинхронные команды listChannels...')

        $listChannels = listChannels(nodeStorage)
        $feeReport    = feeReport(nodeStorage)

        debug('Ожидается завершение асинхронных команд listChannels...')

        $listChannels = await $listChannels
        $feeReport = await $feeReport

        debug('Данные получены полностью, обработка')

        await researchChannels()
        console.log(
            `Amount of bad channel: %d

Liquidity stats:
Sum of all remote balances to us: %d BTC
Sum of all local balances from us: %d BTC
Local/Remote balances of all channels: %d%% / %d%%
We need inbound liquidity for rebalance: %d BTC (better 2x: %d BTC)

Stats after update fee of channels
Amount of private ones: %d
Amount of ones between my nodes: %d
Amount of balanced (%d%%-%d%%) ones: %d
Amount of unbalanced ones (local balance > 60%%): %d
Amount of unbalanced ones (local balance < 30%%): %d
`,
            amntBadChannels,
            sumRemoteBalance / 100000000,
            sumLocalBalance / 100000000,
            Math.round(sumLocalBalance / (sumLocalBalance + sumRemoteBalance) * 100),
            Math.round(sumRemoteBalance / (sumLocalBalance + sumRemoteBalance) * 100),
            sumForRebalance / 100000000,
            sumForRebalance / 100000000 * 2,
            amntPrivateChannels,
            amntMyChannels,
            LOWER_LOCAL_BALANCE * 100,
            UPPER_LOCAL_BALANCE * 100,
            amntBalancedChannels,
            amntUnbalancedUpperLocalBalanceChannels,
            amntUnbalancedLowerLocalBalanceChannels
        )
    }
    catch (e) {
        console.error("Ошибка в main(): %s", e.message())
    }
}

function* updatePromise() {
    // Проходим по каналам и собираем информацию для корректировки

    let channelsByChannelPoint  = {}

    let channels = Object.entries($listChannels).map(
        val => {
            let key = val[0];
            return val[1].channels.map( val => {
                let res = { key: key, channel: val, rand: Math.random() }
                //debug('p_1, %s', val.channel_point)
                channelsByChannelPoint[`${key}-${val.channel_point}`] = res
                return res
            } )
        }
    )
        .reduce( (acc, val) => acc.concat(val), [])
        .sort( (a, b) => a.rand - b.rand)

    for (let key in $feeReport) {
        for (let item of $feeReport[key].channel_fees) {
            let res
            if ((res = channelsByChannelPoint[`${key}-${item.channel_point}`])) {
                debug('p_2, %s', item.channel_point)
                res.fee = {base_fee_msat: item.base_fee_msat, fee_per_mil: item.fee_per_mil}
            }
        }
    }

    console.log("Количество каналов для обновления: %d", channels.length)

    // debug("researchChannels(): после сортировки: %o", channels)
    // console.log("update one channel")

    let amount = 0

    for (let channel of channels) {
        try {
            let localBalance = Number(channel.channel.local_balance)
            let remoteBalance = Number(channel.channel.remote_balance)
            let capacity = Number(channel.channel.capacity)
            let data

            sumRemoteBalance += remoteBalance
            sumLocalBalance  += localBalance

            if ( amount % 100 == 0)
                console.log("Обновляем каналы: N=%d", amount)
            amount++
            let {hash, index} = splitChannelPoint(channel.channel.channel_point)

            if (channel.channel.private) {
                debug('Приватный канал - поступаем иначе, чем со всеми - фиксированные комиссии')
                data = Object.assign({
                    chan_point: {
                        funding_txid_str: hash,
                        output_index:     index
                    },
                    time_lock_delta: FOREIGN_DELTA_CLTV
                }, findBestFee({amount: PAYMENT_AVERAGE, percent: TARGET_FEE_PRIVATE / FEE_DENOMINATOR}))

                debug("updateChannelPolicy (@%s): %o", channel.key, data)
                amntPrivateChannels++

                if (feeNotChanged(data, channel) || program.dryRun) {
                    if (program.dryRun)
                        debug('updateChannelPolicy не будет запущена - включена dry-run!')
                    yield Promise.resolve(1)
                }
                else {
                    console.log(`Обновление private fee канала: ${channel.key}/${data.chan_point.funding_txid_str}:${data.chan_point.output_index} ${channel.fee && channel.fee.base_fee_msat || 'NULL'}->${data.base_fee_msat}/${channel.fee && channel.fee.fee_per_mil || 'NULL'}->${data.fee_per_mil}`)
                    yield nodeStorage.nodes[channel.key].client.updateChannelPolicy(data)
                        .catch(e => {
                            console.log("updateChannelPolicy ОШИБКА (@%s): %o\nОШИБКА: %s", channel.key, data, e.message)
                        })
                }
            }
            else if (myNodes.hasOwnProperty(channel.channel.remote_pubkey)) {
                console.log("Канал со своей нодой (%s<->%s), capacity: %d", channel.key, myNodes[channel.channel.remote_pubkey], channel.channel.capacity)

                data = Object.assign({
                    chan_point: {
                        funding_txid_str: hash,
                        output_index:     index
                    },
                    time_lock_delta: LOCAL_DELTA_CLTV
                }, findBestFee({amount: PAYMENT_BIGGEST, percent: TARGET_FEE_OUR_NODE / FEE_DENOMINATOR}))

                debug("updateChannelPolicy (@%s): %o", channel.key, data)
                amntMyChannels++
                if (feeNotChanged(data, channel) || program.dryRun) {
                    if (program.dryRun)
                        debug('updateChannelPolicy не будет запущена - включена dry-run!')
                    yield Promise.resolve(1)
                }
                else {
                    console.log(`Обновление fee канала: ${channel.key}/${data.chan_point.funding_txid_str}:${data.chan_point.output_index} ${channel.fee && channel.fee.base_fee_msat || 'NULL'}->${data.base_fee_msat}/${channel.fee && channel.fee.fee_per_mil || 'NULL'}->${data.fee_per_mil}`)
                    yield nodeStorage.nodes[channel.key].client.updateChannelPolicy(data)
                        .catch(e => {
                            console.log("updateChannelPolicy ОШИБКА (@%s): %o\nОШИБКА: %s", channel.key, data, e.message)
                        })
                }
            }
            else {
                let lbPart = localBalance / capacity
                if (lbPart >= LOWER_LOCAL_BALANCE && lbPart <= UPPER_LOCAL_BALANCE) {
                    // normal market fee
                    data = Object.assign({
                            chan_point: {
                                funding_txid_str: hash,
                                output_index:     index
                            },
                            time_lock_delta: FOREIGN_DELTA_CLTV
                        },
                        lbPart < LOWER_LOCAL_BALANCE_CHANGE_FEE
                            ?
                            findBestFee({amount: PAYMENT_AVERAGE, percent: Math.round(TARGET_FEE_STOP * 0.7) / FEE_DENOMINATOR})
                            :
                            findBestFee({amount: capacity / 20000, percent: TARGET_FEE_BALANCED * 2 / FEE_DENOMINATOR}, {amount: capacity / 10, percent: TARGET_FEE_BALANCED / FEE_DENOMINATOR})
                    )

                    debug("updateChannelPolicy (@%s): %o", channel.key, data)
                    amntBalancedChannels++
                    if (feeNotChanged(data, channel) || program.dryRun) {
                        if (program.dryRun)
                            debug('updateChannelPolicy не будет запущена - включена dry-run!')
                        yield Promise.resolve(1)
                    }
                    else {
                        console.log(`Обновление fee канала: ${channel.key}/${data.chan_point.funding_txid_str}:${data.chan_point.output_index} ${channel.fee && channel.fee.base_fee_msat || 'NULL'}->${data.base_fee_msat}/${channel.fee && channel.fee.fee_per_mil || 'NULL'}->${data.fee_per_mil}`)
                        yield nodeStorage.nodes[channel.key].client.updateChannelPolicy(data)
                            .catch(e => {
                                console.log("updateChannelPolicy ОШИБКА (@%s): %o\nОШИБКА: %s", channel.key, data, e.message)
                            })
                    }
                }
                else if (lbPart < LOWER_LOCAL_BALANCE) {
                    // big comissions
                    data = Object.assign({
                        chan_point: {
                            funding_txid_str: hash,
                            output_index:     index
                        },
                        time_lock_delta: FOREIGN_DELTA_CLTV
                    }, findBestFee({amount: PAYMENT_AVERAGE, percent: TARGET_FEE_STOP / FEE_DENOMINATOR}))

                    // Вычитаем столько сатоши, сколько не хватает до нижней границы
                    sumForRebalance += Math.round(localBalance - capacity * LOWER_LOCAL_BALANCE)

                    debug("updateChannelPolicy (@%s): %o", channel.key, data)
                    amntUnbalancedLowerLocalBalanceChannels++
                    if (feeNotChanged(data, channel) || program.dryRun) {
                        if (program.dryRun)
                            debug('updateChannelPolicy не будет запущена - включена dry-run!')
                        yield Promise.resolve(1)
                    }
                    else {
                        console.log(`Обновление fee канала: ${channel.key}/${data.chan_point.funding_txid_str}:${data.chan_point.output_index} ${channel.fee && channel.fee.base_fee_msat || 'NULL'}->${data.base_fee_msat}/${channel.fee && channel.fee.fee_per_mil || 'NULL'}->${data.fee_per_mil}`)
                        yield nodeStorage.nodes[channel.key].client.updateChannelPolicy(data)
                            .catch(e => {
                                console.log("updateChannelPolicy ОШИБКА (@%s): %o\nОШИБКА: %s", channel.key, data, e.message)
                            })
                    }

                }
                else {
                    // zero fee for rebalancing
                    data = Object.assign({
                        chan_point: {
                            funding_txid_str: hash,
                            output_index:     index
                        },
                        time_lock_delta: FOREIGN_DELTA_CLTV
                    }, findBestFee({amount: PAYMENT_AVERAGE, percent: TARGET_FEE_CHEAP / FEE_DENOMINATOR}))

                    // Прибавляем столько сатоши, сколько свыше верхней границы
                    sumForRebalance += Math.round(localBalance - capacity * UPPER_LOCAL_BALANCE)

                    debug("updateChannelPolicy (@%s): %o", channel.key, data)
                    amntUnbalancedUpperLocalBalanceChannels++
                    if (feeNotChanged(data, channel) || program.dryRun) {
                        if (program.dryRun)
                            debug('updateChannelPolicy не будет запущена - включена dry-run!')
                        yield Promise.resolve(1)
                    }
                    else {
                        console.log(`Обновление fee канала: ${channel.key}/${data.chan_point.funding_txid_str}:${data.chan_point.output_index} ${channel.fee && channel.fee.base_fee_msat || 'NULL'}->${data.base_fee_msat}/${channel.fee && channel.fee.fee_per_mil || 'NULL'}->${data.fee_per_mil}`)
                        yield nodeStorage.nodes[channel.key].client.updateChannelPolicy(data)
                            .catch(e => {
                                console.log("updateChannelPolicy ОШИБКА (@%s): %o\nОШИБКА: %s", channel.key, data, e.message)
                            })
                    }
                }
            }
        }
        catch (e) {
            console.error("updatePromise, ERROR, продолжаем...: %o", e)
            yield Promise.resolve(1)
        }
    }
}

function feeNotChanged(data, channel) {
    debug('feeNotChanged, data: %o, channel: %o', data, channel)
    if (! channel.fee) {
        amntBadChannels++
        console.log('Канал, который скорее всего не существует: %o', channel)
        return false
    }
    let res = ! program.cltvChanged && (data.base_fee_msat == channel.fee.base_fee_msat && data.fee_per_mil == channel.fee.fee_per_mil)
    debug('feeNotChanged, data: %o, channel: %o, res=%s', data, channel, res ? 'true' : 'false')
    return res
}

async function researchChannels() {
    // The number of promises to process simultaneously.
    let concurrency = 100

    // Create a pool.
    let pool = new PromisePool(updatePromise(), concurrency)

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
        console.error('ОШИБКА: error: %o: ', event.data.error.message)
    })

    console.log(`Запускается update каналов (в параллель: ${concurrency})`)

    // Start the pool.
    let poolPromise = pool.start()

    // Wait for the pool to settle.
    try {
        await poolPromise
        console.log('Всё завершено успешно')
    }
    catch (e) {
        console.log('Встретилась ошибка - прервано: %s', e.message)
    }
}
