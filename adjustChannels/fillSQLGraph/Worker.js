/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const mysqlConnectOpts = require('../../conf/mysqlConnectOpts')
let pool = require('mysql2/promise').createPool(mysqlConnectOpts())

let describeGraph = require('../../lib/describeGraph')
let getInfo = require('../../lib/getInfo')

var PromisePool = require('es6-promise-pool')
let Long = require('long')

const nodeStorage = require('../../global/nodeStorage');

const debug = require('debug')('lnbig:worker')

let $describeGraph,
    $getInfo,
    promiseInit = null

module.exports.main = function main() {
    process.on('message', (msg) => {
        switch (msg.cmd) {
            case 'init':
                promiseInit = prepareNodeStorage(msg.password, msg.key)
                break
            case 'run':
                mainWorker()
        }
    })
}

function prepareNodeStorage(password, key) {
    return nodeStorage.init({[key]: require('../../global/nodesInfo')[key]}, password)
}

async function mainWorker() {
    // To create object for node storage
    await promiseInit

    // To connect to nodes
    await nodeStorage.connect({longsAsNumbers: false});

    debug(`Запускаются (${process.pid}) асинхронные команды listChannels...`)

    $describeGraph = describeGraph(nodeStorage)
    $getInfo      = getInfo(nodeStorage)

    debug(`Ожидается (${process.pid}) завершение асинхронных команд listChannels...`)

    $describeGraph  = await $describeGraph
    $getInfo  = await $getInfo

    debug(`Данные (${process.pid}) получены полностью, обработка`)

    await updateSQLGraph()
    debug(`worker ${process.pid} is exiting`)
    process.exit()
}

function* sqlCommandPromise() {
    for (let key in nodeStorage.nodes) {
        console.log("Обработка с ноды %s", key)
        if (nodeStorage.nodes[key].client) {
            console.log("Обработка узлов графа (@%s)", key)
            for(let node of $describeGraph[key].nodes) {
                yield addNode(node)
            }
            console.log("Обработка рёбер (каналов) графа (@%s)", key)
            for(let edge of $describeGraph[key].edges) {
                yield addChannel(edge)
            }
        }
    }
}

async function addNode(node) {
    let connection = await pool.getConnection()
    await connection.beginTransaction()

    let res, dbLastUpdate = null

    ;[res] = await connection.execute(
        "SELECT nodeid, last_update FROM node WHERE pubkey=UNHEX(LPAD(?,66,'0'))",
        [node.pub_key]
    )

    let nodeid

    if (res.length === 0) {
        // Узла ещё нет - создаём
        [res] = await connection.execute(
            "INSERT INTO node SET pubkey=UNHEX(LPAD(?,66,'0')), added=NOW(), last_update=?",
            [node.pub_key, node.last_update]
        )
        nodeid = res.insertId
    }
    else {
        nodeid = res[0].nodeid
        dbLastUpdate = res[0].last_update
    }
    debug('pubKey=%s, nodeid=%d', node.pub_key, nodeid)

    for (let address of node.addresses) {
        if (! dbLastUpdate || node.last_update > dbLastUpdate) {
            [res] = await connection.execute(
                "INSERT IGNORE INTO address SET nodeid=?, address=?, md5_key=UNHEX(LPAD(MD5(CONCAT(?,'|',?)),32,'0'))",
                [nodeid, address.addr, nodeid.toString(), address.addr]
            )
        }
        await connection.execute(`INSERT IGNORE INTO address_trg (md5_key) SELECT UNHEX(LPAD(MD5(CONCAT(?,'|',?)),32,'0'))`, [nodeid.toString(), address.addr])
    }

    if (! dbLastUpdate || node.last_update > dbLastUpdate) {
        [res] = await connection.execute(
            "INSERT IGNORE INTO alias SET nodeid=?, alias=?, md5_key=UNHEX(LPAD(MD5(CONCAT(?,'|',?)),32,'0'))",
            [nodeid, node.alias, nodeid.toString(), node.alias]
        )
    }
    await connection.execute(`INSERT IGNORE INTO alias_trg (md5_key) SELECT UNHEX(LPAD(MD5(CONCAT(?,'|',?)),32,'0'))`, [nodeid.toString(), node.alias])

    await connection.commit()
    await connection.release()
}

async function addChannel(edge) {
    let connection = await pool.getConnection()
    await connection.beginTransaction()

    let res,
        nodeid1,
        nodeid2

        // Получаем информацию о первом узле
    ;[res] = await connection.execute(
        "SELECT nodeid FROM node WHERE pubkey=UNHEX(LPAD(?,66,'0'))",
        [edge.node1_pub]
    )

    if (res.length === 1)
        nodeid1 = res[0].nodeid
    else
        throw Error("edge ссылается на несуществующий узел")

            // Получаем информацию о втором узле
            ;[res] = await connection.execute(
        "SELECT nodeid FROM node WHERE pubkey=UNHEX(LPAD(?,66,'0'))",
        [edge.node2_pub]
    )

    if (res.length === 1)
        nodeid2 = res[0].nodeid
    else
        throw Error("edge ссылается на несуществующий узел")

    if (nodeid1 === nodeid2) {
        console.log("edge ссылается на тот же узел (%s / %s) / (%d / %d) (петля)", edge.node1_pub, edge.node2_pub, nodeid1, nodeid2)
    }

    debug("p_3, %o, %o", edge.node1_policy, edge.node2_policy)

    ;[res] = await connection.execute(
        "SELECT channel_id FROM channel WHERE channel_id=?",
        [edge.channel_id]
    )

    if (res.length < 1) {
        debug("Добавляем канал в базу (%s)", edge.channel_id)
        // Надо добавить канал
        ;[res] = await connection.execute(
            `INSERT INTO channel
             SET
                channel_id=?,
                nodeid_1=?,
                nodeid_2=?,
                block_height=?,
                tx_index=?,
                output_index=?,
                txid=UNHEX(LPAD(?,64,'0')),
                capacity=?
             `,
            [
                edge.channel_id,
                nodeid1,
                nodeid2,
                Long.fromString(edge.channel_id).shru(40).toNumber(),
                Long.fromString(edge.channel_id).shru(16).and(0xFFFFFF).toNumber(),
                Long.fromString(edge.channel_id).and(0xFFFF).toNumber(),
                /^(.*):\d+$/.exec(edge.chan_point)[1],
                edge.capacity
            ]
        )
    }
    else {
        debug("Канал уже есть в базе")
    }

    await connection.execute(`INSERT IGNORE INTO channel_trg SET channel_id=?`, [edge.channel_id])

    // Обновляем policy nodeid1
    await updatePolicy({
        connection,
        channel_id: edge.channel_id,
        nodeid: nodeid1,
        policy: edge.node1_policy,
        last_update: edge.last_update
    })

    // Обновляем policy nodeid2
    await updatePolicy({
        connection,
        channel_id: edge.channel_id,
        nodeid: nodeid2,
        policy: edge.node2_policy,
        last_update: edge.last_update
    })

    await connection.commit()
    await connection.release()
}

async function updatePolicy({connection, channel_id, nodeid, policy, last_update}) {
    if (policy !== null) {
        let [res] = await connection.execute(`
            SELECT
                last_update<? AS changed_last_update,
                last_update
            FROM
                chan_policy_side
            WHERE
                channel_id=? AND nodeid=?
            `,
            [
                last_update,
                channel_id,
                nodeid
            ]

        )
        debug('p_1 (%s/%d): new_last_update: %d, res=%o', channel_id, nodeid, last_update, res)
        if (res.length === 1 && !!+ res[0].changed_last_update || res.length === 0) {
            debug('p_2 (%s/%d): new_last_update: %d, res=%o', channel_id, nodeid, last_update, res)
            //  Время больше или данных нет - меняем или добавляем данные
            ;[res] = await connection.execute(`
                INSERT INTO chan_policy_side
                SET
                    channel_id=?,
                    nodeid=?,
                    last_update=?,
                    time_lock_delta=?,
                    min_htlc=?,
                    fee_base_msat=?,
                    fee_rate_milli_msat=?,
                    disabled=?,
                    max_htlc_msat=?
                ON DUPLICATE KEY UPDATE
                    last_update=VALUES(last_update),
                    time_lock_delta=VALUES(time_lock_delta),
                    min_htlc=VALUES(min_htlc),
                    fee_base_msat=VALUES(fee_base_msat),
                    fee_rate_milli_msat=VALUES(fee_rate_milli_msat),
                    disabled=VALUES(disabled),
                    max_htlc_msat=VALUES(max_htlc_msat)
                `,
                [
                    channel_id,
                    nodeid,
                    last_update,
                    policy.time_lock_delta,
                    policy.min_htlc,
                    policy.fee_base_msat,
                    policy.fee_rate_milli_msat,
                    policy.disabled,
                    policy.max_htlc_msat
                ]
            )
            debug('insert/update (%s/%d): affected: %d, changed: %d, data: %o',
                channel_id, nodeid, res.affectedRows, res.changedRows,
                { res: { ...policy, last_update } }
            )
        }
    }
}

async function updateSQLGraph() {
    // The number of promises to process simultaneously.
    let concurrency = 3

    // Create a pool.
    let pool = new PromisePool(sqlCommandPromise(), concurrency)

    pool.addEventListener('fulfilled', function (event) {
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
    await pool.end()
}
