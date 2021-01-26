/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

// Должен быть первым - загружает переменные
require('dotenv').config()

let feeReport = require('../lib/feeReport')
var _ = require('lodash');

const nodeStorage = require('../global/nodeStorage');

const debug = require('debug')('lnbig:feereport')

let
    myNodes = {};

let $feeReport

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
    await nodeStorage.connect();

    debug('Запускаются асинхронные команды feeReport...')

    $feeReport = feeReport(nodeStorage)

    debug('Ожидается завершение асинхронных команд feeReport...')

    $feeReport = await $feeReport

    debug('Данные получены полностью, обработка')

    printReport($feeReport)
}

function printReport(feeReport) {
    let day_fee = 0

    _.forEach(feeReport, ({day_fee_sum}) => { day_fee += day_fee_sum })
    console.log("Last 24 hours fee earning: %i sat (%f BTC)", day_fee, day_fee / 100000000)
}
