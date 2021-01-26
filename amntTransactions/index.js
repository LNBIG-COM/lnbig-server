/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

// Должен быть первым - загружает переменные
require('dotenv').config()

let forwardingHistory = require('../lib/forwardingHistory')
var _ = require('lodash');

const nodeStorage = require('../global/nodeStorage');

const debug = require('debug')('lnbig:fwdinfhistory')

let
    myNodes = {};

let $forwardingHistory

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

    debug('Запускаются асинхронные команды forwardingHistory...')

    $forwardingHistory = forwardingHistory(nodeStorage,
        {
            start_time: Date.now()/1000 - 86400 * 30,
            end_time: Date.now()/1000,
            index_offset: 0,
            num_max_events: 50000
    })

    debug('Ожидается завершение асинхронных команд forwardingHistory...')

    $forwardingHistory = await $forwardingHistory

    debug('Данные получены полностью, обработка')

    printReport($forwardingHistory)
}

function printReport(forwardingHistory) {
    let amount = 0

    _.forEach(forwardingHistory, res => {
        debug("length array=%d, last_offset_index=%d", res.forwarding_events.length, res.last_offset_index)
        amount += res.forwarding_events.length
    })
    console.log("Количество транзакций за месяц: %i", amount)
}

