/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

var program = require('commander')
const mysqlConnectOpts = require('../../conf/mysqlConnectOpts')
let pool = require('mysql2/promise').createPool(mysqlConnectOpts())

const nodeStorage = require('../../global/nodeStorage');

const debug = require('debug')('lnbig:dwoc')
const util = require('util')

function main (cluster) {
    program
        .version('0.1.0')
        .option('-n, --dry-run', 'Проверочный запуск без действий')
        .parse(process.argv);

    console.log("Параметры запуска:\n%s",
        program.dryRun ? "Запуск НЕ НАСТОЯЩИЙ\n" : 'НОРМАЛЬНЫЙ запуск',
    )

    if (process.env.CRYPT_PASSWORD) {
        // The password for crypted macaroon files in env settings (.env file for example)
        mainMaster(process.env.CRYPT_PASSWORD, cluster)
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
                mainMaster(password, cluster);
            }
        )
    }
}

async function mainMaster(password, cluster) {
    // To create object for node storage

    // load node storage data included crypted macaroon files, and decrypt macaroon files by password. After the password to be cleaned from memory
    await nodeStorage.init(require('../../global/nodesInfo'), password);

    await prepareForUpdate()

    for (let key in nodeStorage.nodes) {
        let item

        let worker = cluster.fork()
        worker.send({cmd: 'init', password: password, key: key})
        worker.send({cmd: 'run'})
    }

    debug("Ждём завершения всех workers")
    await (util.promisify(cluster.disconnect.bind(cluster)))()
    debug("Все worker отработали")
    await executePostUpdate()
    await pool.end()

    process.exit(0)
}

async function prepareForUpdate() {
    let connection = await pool.getConnection()

    console.log("Создаём промежуточные таблицы в памяти");
    await connection.query(
        `DROP TABLE IF EXISTS channel_trg`
    )
    await connection.query(
        `DROP TABLE IF EXISTS address_trg`
    )
    await connection.query(
        `DROP TABLE IF EXISTS alias_trg`
    )

    await connection.query(
        `CREATE TABLE channel_trg (
            channel_id  BIGINT UNSIGNED NOT NULL,
            UNIQUE (channel_id)
        ) ENGINE=MEMORY`
    )
    await connection.query(
        `CREATE TABLE address_trg (
            md5_key     BINARY(16) NOT NULL,
            UNIQUE (md5_key)
        ) ENGINE=MEMORY`
    )
    await connection.query(
        `CREATE TABLE alias_trg (
            md5_key     BINARY(16) NOT NULL,
            UNIQUE (md5_key)
        ) ENGINE=MEMORY`
    )

    await connection.release()
}

async function executePostUpdate() {
    let connection = await pool.getConnection()
    await connection.beginTransaction()

    console.log("Делаем пост-обновление: создаём архивные данные и определяем закрытые каналы");
    await connection.query(
        `
        UPDATE
            channel INNER JOIN (
                SELECT channel.channel_id FROM channel LEFT JOIN channel_trg ON channel.channel_id=channel_trg.channel_id WHERE channel_trg.channel_id IS NULL
            ) AS c1 ON c1.channel_id=channel.channel_id
        SET pruned=TRUE`
    )

    // Адреса, которые не были обновлены - отправляются в архив - позже они будут удалены
    await connection.query(
        `
        INSERT
        INTO
            address_hist (nodeid, address, last_update)
        SELECT
            address.nodeid,
            address.address,
            node.last_update
        FROM
                (SELECT address.md5_key FROM address LEFT JOIN address_trg ON address.md5_key=address_trg.md5_key WHERE address_trg.md5_key IS NULL) AS t1
            INNER JOIN
                address ON t1.md5_key=address.md5_key
            INNER JOIN
                node ON address.nodeid=node.nodeid`
    )
    await connection.query(
        `
        INSERT
        INTO
            alias_hist (nodeid, alias, last_update)
        SELECT
            alias.nodeid,
            alias.alias,
            node.last_update
        FROM
                (SELECT alias.md5_key FROM alias LEFT JOIN alias_trg ON alias.md5_key=alias_trg.md5_key WHERE alias_trg.md5_key IS NULL) AS t1
            INNER JOIN
                alias ON t1.md5_key=alias.md5_key
            INNER JOIN
                node ON alias.nodeid=node.nodeid`
    )

    await connection.query(
        `
        DELETE address
        FROM
                (SELECT address.md5_key FROM address LEFT JOIN address_trg ON address.md5_key=address_trg.md5_key WHERE address_trg.md5_key IS NULL) AS t1
            INNER JOIN
                address ON t1.md5_key=address.md5_key`
    )

    await connection.query(
        `
        DELETE alias
        FROM
                (SELECT alias.md5_key FROM alias LEFT JOIN alias_trg ON alias.md5_key=alias_trg.md5_key WHERE alias_trg.md5_key IS NULL) AS t1
            INNER JOIN
                alias ON t1.md5_key=alias.md5_key`
    )

    await connection.query(
        `DROP TABLE IF EXISTS address_trg`
    )
    await connection.query(
        `DROP TABLE IF EXISTS alias_trg`
    )
    await connection.query(
        `DROP TABLE IF EXISTS channel_trg`
    )

    await connection.commit()
    await connection.release()
}

module.exports = { main }
