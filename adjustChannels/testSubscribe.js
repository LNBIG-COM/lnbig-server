/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

// To see algorithm here: https://gist.github.com/LNBIG-COM/dfe5d25bcea25612c559e02fd7698660
// In this file there are many debugging info now. And russian-language comments for me
// Должен быть первым - загружает переменные
require('dotenv').config()
const debug = require('debug')('lnbig:testsub')

let program = require('commander')
let qMemcached = require('memcache-promise')
const cache = new qMemcached("localhost:11211");
const stringify = require('json-stringify-deterministic')
var md5 = require('md5')

const MEMCACHE_EXPIRES = 31

function collectArg(val, array) {
    array.push(val)
    return array
}

program
    .version('0.1.0')
    .option('-n, --dry-run', 'Проверочный запуск без действий')
    .option('-f, --filter <node_updates|channel_updates|closed_chans>', 'Символные ключи, по которым фильтровать', collectArg, [])
    .parse(process.argv)

debug("program.filter=%o", program.filter)
let filterKeys = (program.filter.length && program.filter || ['node_updates', 'channel_updates', 'closed_chans']).reduce( (acc, val) => { acc[val] = 1; return acc; }, {} )

console.log("Параметры запуска:\n%s\nfilterKeys: %o",
    program.dryRun ? "Запуск НЕ НАСТОЯЩИЙ\n" : 'НОРМАЛЬНЫЙ запуск',
    filterKeys
)

process.umask(0o77);

const nodeStorage = require('../global/nodeStorage');


let
    myNodes = {}

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
    let data = subscribeEvent(nodeStorage)
    for (let key in data) {
        console.log("Подписываемся на события %s", key)
        data[key].on('data', data => {
            //console.log("data (%s): %o", key, data )
            getActualKeys(data)
            //if (data.channel_updates.length > 0) {
            //    for (let obj of data.channel_updates) {
            //        console.log("obj.chan_point: %o, %s, %o", obj.chan_point.funding_txid_bytes, obj.chan_point.funding_txid_str, obj.chan_point)
            //    }
            //}
        })
        data[key].on('end', () => { console.log("end %s", key ) })
        data[key].on('error', e => { console.log("error (%s): %s", key, e ) })
        data[key].on('status', status => { console.log("status (%s): %s", key, status ) })
    }
}

function subscribeEvent(nodeStorage) {
    let data = {};
    Object.values(nodeStorage.nodes).map(item => {
        let {key, client} = item;
        if (client)
            data[key] = client.subscribeChannelGraph({});
    })
/*
    for (let key in data) {
        data[key] = await data[key];
        console.log(`Ответ subscribeChannelGraph от ${key} получен`);
    }*/
    return data;

}

async function getActualKeys (event) {
    debug('getActualKeys: %o', event)
    let fullList =
        Object.keys(event)
            .reduce( (acc, key) => {
                return acc.concat(event[key].map( val => { return { key: key, val: val }}))
            }, [])
    if (fullList.length > 1)
        debug('fullList array: %o', fullList)
    for (let item of fullList) {
        if (! filterKeys[item.key])
            continue
        debug("fullList item: %o", item)
        try {
            await cache.add(md5(stringify(item)), 1, MEMCACHE_EXPIRES)
            console.log("Событие впервые: %o", item)
        }
        catch(e) {
            debug('Вызвана catch, s=%s, e=%o', e.message, e)
            if (e.notStored)
                debug("Событие повторное: %o", item)
            else
                throw e
        }
    }

}

/*
Примеры:

Событие впервые: { key: 'closed_chans',
  val:
   { chan_id: '593904504379473920',
     capacity: '5000000',
     closed_height: 586049,
     chan_point:
      { output_index: 0,
        funding_txid_bytes:
         <Buffer b8 7d ef 1b d0 4f c8 85 82 f8 53 52 fc 11 23 be 15 86 2f 8c 39 40 8b 69 41 c9 64 31 ca 97 39 0f>,
        funding_txid: 'funding_txid_bytes' } } }
Событие впервые: { key: 'closed_chans',
  val:
   { chan_id: '633676038949896192',
     capacity: '35000',
     closed_height: 586049,
     chan_point:
      { output_index: 0,
        funding_txid_bytes:
         <Buffer e6 42 ab de 9f 63 3c 79 5c 6e b7 d2 94 fb 14 67 31 41 ad 0e 16 d5 26 f3 64 c8 2f 9a 12 63 9d 37>,
        funding_txid: 'funding_txid_bytes' } } }

Событие впервые: { key: 'node_updates',
  val:
   { addresses: [ '47.198.17.167:9737', [length]: 1 ],
     identity_key:
      '02995d6e1c56bfab5da9a8177f014e1c9e590781270641a9ae6a2bd4adc8f1f497',
     global_features: <Buffer >,
     alias: 'SatsPay',
     color: '#3399ff' } }
Событие впервые: { key: 'node_updates',
  val:
   { addresses: [ '47.198.17.167:9737', [length]: 1 ],
     identity_key:
      '02995d6e1c56bfab5da9a8177f014e1c9e590781270641a9ae6a2bd4adc8f1f497',
     global_features: <Buffer >,
     alias: 'SatsPay',
     color: '#3399ff' } }
Событие впервые: { key: 'node_updates',
  val:
   { addresses: [ '86.30.249.21:9735', [length]: 1 ],
     identity_key:
      '026087e0cec86201f617c6b93528091fd522112cf499eec18f778576e5f883c150',
     global_features: <Buffer >,
     alias: 'Grand-Guignol',
     color: '#3399ff' } }
Событие впервые: { key: 'node_updates',
  val:
   { addresses: [ '86.30.249.21:9735', [length]: 1 ],
     identity_key:
      '026087e0cec86201f617c6b93528091fd522112cf499eec18f778576e5f883c150',
     global_features: <Buffer >,
     alias: 'Grand-Guignol',
     color: '#3399ff' } }
Событие впервые: { key: 'node_updates',
  val:
   { addresses: [ '86.30.249.21:9735', [length]: 1 ],
     identity_key:
      '026087e0cec86201f617c6b93528091fd522112cf499eec18f778576e5f883c150',
     global_features: <Buffer >,
     alias: 'Grand-Guignol',
     color: '#3399ff' } }

* */
