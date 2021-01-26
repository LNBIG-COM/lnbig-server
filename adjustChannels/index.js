/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

// Должен быть первым - загружает переменные
require('dotenv').config()

process.exit(1);

let listChannels = require('../lib/listChannels')
var PromisePool = require('es6-promise-pool')

const SMALL_CHANNEL = 0;
const MIDDLE_CHANNEL = 1;
const BIG_CHANNEL = 2;

const FOREIGN_DELTA_CLTV = 60

// let rules = {
//     [SMALL_CHANNEL]: {
//         min: 0,
//         max: 5000000,
//         base_fee: 0,
//         fee_rate: 450
//     },
//     [MIDDLE_CHANNEL]: {
//         min: 5000000 + 1,
//         max: 10000000,
//         base_fee: 250,
//         fee_rate: 200
//     },
//     [BIG_CHANNEL]: {
//         min: 10000000 + 1,
//         max: 2**24,
//         base_fee: 500,
//         fee_rate: 100
//     }
// }

let rules = {
    [SMALL_CHANNEL]: {
        min: 0,
        max: 5000000,
        base_fee: 0,
        fee_rate: 1
    },
    [MIDDLE_CHANNEL]: {
        min: 5000000 + 1,
        max: 10000000,
        base_fee: 0,
        fee_rate: 1
    },
    [BIG_CHANNEL]: {
        min: 10000000 + 1,
        max: 2**24,
        base_fee: 0,
        fee_rate: 1
    }
}

process.umask(0o77);

const nodeStorage = require('../global/nodeStorage');

const debug = require('debug')('lnbig:dwoc')

let
    myNodes = {};

let $listChannels


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

    for (let key in nodeStorage.nodes)
        myNodes[nodeStorage.nodes[key].pubKey] = key

    debug("Мои ноды: %o", myNodes)

    // To connect to nodes
    await nodeStorage.connect({longsAsNumbers: false});

    debug('Запускаются асинхронные команды listChannels...')

    $listChannels = listChannels(nodeStorage)

    debug('Ожидается завершение асинхронных команд listChannels...')

    $listChannels = await $listChannels

    debug('Данные получены полностью, обработка')

    researchChannels()
}

function* updatePromise() {
    // Проходим по каналам и собираем информацию для корректировки

    let channels = Object.entries($listChannels).map(
        val => {
            let key = val[0];
            return val[1].channels.map( val => { return { key: key, channel: val, rand: Math.random() } } )
        }
    )
        .reduce( (acc, val) => acc.concat(val), [])
        .sort( (a, b) => a.rand - b.rand)

    console.log("Количество каналов для обновления: %d", channels.length)

    // debug("researchChannels(): после сортировки: %o", channels)
    // console.log("update one channel")

    let rule, data, amount = 0
    for (let channel of channels) {
        if ( amount % 100 == 0)
            console.log("Обновляем каналы: N=%d", amount)
        amount++
        if (myNodes.hasOwnProperty(channel.channel.remote_pubkey)) {
            console.log("Канал со своей нодой (%s<->%s), capacity: %d", channel.key, myNodes[channel.channel.remote_pubkey], channel.channel.capacity)
            let channelPoint = /^(.*):(\d+)$/.exec(channel.channel.channel_point)
            data = { chan_point: { funding_txid_str: channelPoint[1], output_index: Number(channelPoint[2])}, base_fee_msat: 0, fee_rate: 0.000001, time_lock_delta: 4}
            debug("updateChannelPolicy (@%s): %o", channel.key, data)
            yield nodeStorage.nodes[channel.key].client.updateChannelPolicy(data)
                 .catch(e => {
                     console.log("updateChannelPolicy ОШИБКА (@%s): %o\nОШИБКА: %s", channel.key, data, e.message)
                 })
        }
        else {
            let localBalance = Number(channel.channel.local_balance)
            for (rule in rules) {
                //debug("rule: %d, %o", rule, rules[rule])
                if (localBalance >= rules[rule].min && localBalance <= rules[rule].max) {
                    let channelPoint = /^(.*):(\d+)$/.exec(channel.channel.channel_point)
                    if (channelPoint) {
                        data = { chan_point: { funding_txid_str: channelPoint[1], output_index: Number(channelPoint[2])}, base_fee_msat: rules[rule].base_fee, fee_rate: rules[rule].fee_rate / 1000000, time_lock_delta: FOREIGN_DELTA_CLTV}
                        debug("updateChannelPolicy (@%s): %o", channel.key, data)
                        yield nodeStorage.nodes[channel.key].client.updateChannelPolicy(data)
                            .catch(e => {
                                console.log("updateChannelPolicy ОШИБКА (@%s): %o\nОШИБКА: %s", channel.key, data, e.message)
                            })
                        break
                    }
                }
            }
        }
    }
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
        console.log('update policy - ОШИБКА: error: %o: ', event.data.error.message)
    })

    console.log(`Запускается update каналов (в параллель: ${concurrency})`)

    // Start the pool.
    let poolPromise = pool.start()

    // Wait for the pool to settle.
    await poolPromise
    console.log('Всё завершено успешно')
}
