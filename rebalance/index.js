/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

// To see algorithm here: https://gist.github.com/LNBIG-COM/dfe5d25bcea25612c559e02fd7698660
// In this file there are many debugging info now. And russian-language comments for me

// Должен быть первым - загружает переменные
require('dotenv').config()
let program = require('commander')

process.umask(0o77);

const nodeStorage = require('../global/nodeStorage');
const { myNodes, myNodesInit } = require('../global/myNodes')
const debug = require('debug')('lnbig:paidRebalance')
const rebalanceBetweenOurNodes = require('./ourNodes')
const rebalanceForeignChannels = require('./foreignNodes')

program
    .version('0.1.0')

let command, options

program
    .command('our')
    .option('-n, --dry-run', 'Проверочный запуск без действий для открытия каналов')
    .action((opts) => {
        command = 'our'
        options = opts
        main()
    })

program
    .command('foreign')
    .description('Ребалансировка внешних каналов (за оплату!)')
    .option(
        '-r, --fee-rate <ppm>',
        'Не более столько ppm за платёж. Если не указано - работает --max-fee-sats',
        (str, def) => parseInt(str || def, 10),
        1100
    )
    .option(
        '-b, --fee-base <millisats>',
        'Если указано - не более base fee за платёж. Если не указано - работает --max-fee-sats',
        (str, def) => parseInt(str || def, 10),
        1000
    )
    .option(
        '-c, --concurrency <runPoolAmount>',
        'Сколько конкурентных потоков создавать',
        (str, def) => parseInt(str || def, 10),
        400
    )
    .option(
        '--attempts <amountOfAttempts>',
        'Количестве попыток оплатить платёж',
        (str, def) => parseInt(str || def, 10),
        20
    )
    .option(
        '-p, --max-balanced-payment <satoshis>',
        'Максимальный платёж для ребаланса - больше него платежи будут разбиваться равные или менее ему части',
        (str, def) => parseInt(str || def, 10),
        1000000)
    .option(
        '-s, --start-round <N>',
        'Стартовать сразу с раунда N (от 1 до 5) (default: 1)',
        (str, def) => parseInt(str || def, 10),
        1)
    .option(
        '-n, --dry-run',
        'Проверочный запуск без действий для открытия каналов'
    )
    .action((opts) => {
        command = 'foreign'
        options = opts
        main()
    })


program
    .parse(process.argv);

function main() {
    require('../lib/promptPassword')(_main)
        .then( () => {
            console.log("Все задачи выполнены")
            process.exit(0)
        })
        .catch( (e) => {
            console.error("ERROR: %s\n%s", e.message, e.stack)
            process.exit(1)
        })
}

async function _main(password) {
    // To create object for node storage

    // load node storage data included crypted macaroon files, and decrypt macaroon files by password. After the password to be cleaned from memory
    await nodeStorage.init(require('../global/nodesInfo'), password)
    myNodesInit(nodeStorage)

    debug("Мои ноды: %o", myNodes)

    // To connect to nodes
    await nodeStorage.connect({longsAsNumbers: false});

    if (command === 'our') {
        await rebalanceBetweenOurNodes(options)
    }
    else if (command === 'foreign') {
        debug('Опции: %o', options)
        await rebalanceForeignChannels(options)
    }
}
