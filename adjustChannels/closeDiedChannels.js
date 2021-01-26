/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

// Должен быть первым - загружает переменные
require('dotenv').config()
var program = require('commander')

program
    .version('0.1.0')
    .option('-n, --dry-run', 'Проверочный запуск без действий')
    .option('-f, --forced', 'Работать с каналами, которые закрыть можно только как forced')
    .option('-o, --older-days <n>', 'Скольки старее дней должны быть каналы', str => parseInt(str), 60)
    .option('-m, --max-btc <n>', 'Скольки максимум освободить BTC', parseFloat)
    .parse(process.argv);

if (program.olderDays < 30) {
    console.log('--older-days не может быть меньше 30 - устанавливаем 60!')
    program.olderDays = 60
}

let listChannels = require('../lib/listChannels')
let getInfo = require('../lib/getInfo')
//let _ = require('lodash')
let Long = require('long')
const grpc = require('grpc')

var PromisePool = require('es6-promise-pool')

process.umask(0o77);

const nodeStorage = require('../global/nodeStorage');

const debug = require('debug')('lnbig:findbadchannels')

let
    myNodes = {},
    maxFree

let $listChannels, $getInfo, currentBlock = 0

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

    $listChannels = listChannels(nodeStorage, program.forced ? { inactive_only: true } : { active_only: true })
    $getInfo      = getInfo(nodeStorage)

    debug('Ожидается завершение асинхронных команд listChannels & getInfo...')

    $listChannels = await $listChannels
    $getInfo      = await $getInfo

    debug('Данные получены полностью, обработка')
    let array = findUselessChannels()

    console.log('массив бесполезных каналов, N=%d', array.length)

    let willBeFree = array.reduce( (acc, val) => acc + val.channel.local_balance, 0)

    console.log('Потенциально для освобождения: %d BTC\nВысвободится: %d BTC', willBeFree / 100000000, program.maxBtc || willBeFree / 100000000)

    maxFree = program.maxBtc || null

    await closeChannels(array)
    console.log('Потенциально для освобождения: %d BTC\nВысвободится: %d BTC', willBeFree / 100000000, program.maxBtc || willBeFree / 100000000)
}

function findUselessChannels() {
    return Object.entries($listChannels).map(
        val => {
            let key = val[0];
            debug(`block_height of ${key} is ${$getInfo[key].block_height}`)
            currentBlock = Math.max(currentBlock, Number($getInfo[key].block_height))

            let res = val[1].channels.filter( item => {
                item.local_balance = Number(item.local_balance)
                item.remote_balance = Number(item.remote_balance)
                item.total_satoshis_received = Number(item.total_satoshis_received)
                item.blockHeight = Long.fromString(item.chan_id, true)
                item.chan_id = Long.fromString(item.chan_id, true)
                item.blockHeight = item.blockHeight.shru(40).toNumber()
                let res = ! item.pending_htlcs.length
                    && item.local_balance > 0
                    && item.remote_balance == 0
                    && item.total_satoshis_received == 0
                    && (currentBlock - item.blockHeight) >= program.olderDays * 144
                    && ! myNodes.hasOwnProperty(item.remote_pubkey)
                if (res)
                    debug('Претендет-канал: %o', item)
                return res
            })

            return res.map( val => { return { key: key, channel: val } } )
        }
    )
        .reduce( (acc, val) => acc.concat(val), [])
        .sort( (a, b) => a.channel.chan_id.compare(b.channel.chan_id) )
}

function* updatePromise(array) {
    try {
        for (let item of array) {
            let channelPoint = /^(.*):(\d+)$/.exec(item.channel.channel_point)
            if (! channelPoint)
                throw new Error('channelPoint is not defined (%o)', item.channel)

            console.log('Закрываем канал (@%s) %s', item.key, item.channel.channel_point)
            let data = {
                channel_point: {
                    funding_txid_str: channelPoint[1],
                    output_index:     Number(channelPoint[2])
                },
                force: ! ! program.forced
            }
            if (! program.forced)
                data.target_conf = 36
            debug('Закрытие канана: item: %o, data: %o', item, data)

            if (! program.dryRun) {
                yield new Promise((resolve, reject) => {
                    let stream = nodeStorage.nodes[item.key].client.closeChannel(data)
                    stream.on('data', data => {
                        debug("data of channel %o: %o", item, data)
                        if (data.update === 'close_pending' || data.update === 'chan_close') {
                            debug('Вызов cancel, %o', item)
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

            debug('maxFree - %d', maxFree)
            if (maxFree !== null && (maxFree -= item.channel.local_balance / 100000000) < 0) {
                console.log("Достигли лимита освобождения средств - заканчиваем")
                return
            }
            yield Promise.resolve(1)
        }
    }
    catch (e) {
        console.log('Ошибка в updatePromise: %s', e.message)
    }
}

async function closeChannels(array) {
    try {
        // The number of promises to process simultaneously.
        let concurrency = 100

        // Create a pool.
        let pool = new PromisePool(updatePromise(array), concurrency)

        pool.addEventListener('fulfilled', function (event) {
            // The event contains:
            // - target:    the PromisePool itself
            // - data:
            //   - promise: the Promise that got fulfilled
            //   - result:  the result of that Promise
            debug('update policy: result: %o', event.data.result)
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
    catch (e) {
        console.log('Ошибка в closeChannels: %s', e.message)
    }
}
