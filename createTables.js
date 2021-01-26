/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

// Должен быть первым - загружает переменные
require('dotenv').config()
var program = require('commander')
const debug = require('debug')('lnbig:create-tables')
const mysqlConnectOpts = require('./conf/mysqlConnectOpts')

program
    .version('0.1.0')
    .option('--recreate', 'Пересоздаёт заново таблицы')
    .parse(process.argv);

let mysql, connection

const tables = [
    `CREATE TABLE IF NOT EXISTS node (
        nodeid      INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        pubkey      BINARY (33) NOT NULL,   # UNHEX(LPAD('hex_pubkey',66,'0'))
        last_update INT UNSIGNED NOT NULL,

        added       DATETIME NOT NULL,
        add_type    ENUM ('unknown', 'lnurl') CHARSET ascii NOT NULL,
        
        UNIQUE      (pubkey)
    )`,

    // address длина - 68 символов максимально для tor3 + ':' + XXXXX порт
    `CREATE TABLE IF NOT EXISTS alias (
        nodeid      INT UNSIGNED NOT NULL,
        alias       CHAR(32) CHARSET utf8mb4 NOT NULL DEFAULT '',

        md5_key     BINARY(16) NOT NULL,   # Нужен только для уникальности и уменьшения размера уникального ключа

        INDEX nodeid (nodeid),
        UNIQUE md5_key (md5_key),                    # UNHEX(LPAD(MD5(CONCAT(nodeid,'|',alias)),32,'0'))
        
        CONSTRAINT alias__nodeid FOREIGN KEY nodeid (nodeid)
            REFERENCES node (nodeid)
            ON DELETE CASCADE
            ON UPDATE CASCADE
    )`,

    // address длина - 68 символов максимально для tor3 + ':' + XXXXX порт
    `CREATE TABLE IF NOT EXISTS alias_hist (
        nodeid      INT UNSIGNED NOT NULL,
        alias       CHAR(32) CHARSET utf8mb4 NOT NULL DEFAULT '',
        last_update INT UNSIGNED NOT NULL, # Берётся из данных node, чтобы отслеживать свежие IPs

        INDEX nodeid (nodeid),
        
        CONSTRAINT alias_hist__nodeid FOREIGN KEY nodeid (nodeid)
            REFERENCES node (nodeid)
            ON DELETE CASCADE
            ON UPDATE CASCADE
    )`,

    // address длина - 68 символов максимально для tor3 + ':' + XXXXX порт
    `CREATE TABLE IF NOT EXISTS address (
        nodeid      INT UNSIGNED NOT NULL,
        address     CHAR(68) CHARSET ascii NOT NULL,

        md5_key     BINARY(16) NOT NULL,   # Нужен только для уникальности и уменьшения размера уникального ключа

        INDEX nodeid (nodeid),
        UNIQUE md5_key (md5_key),          # UNHEX(LPAD(MD5(CONCAT(nodeid,'|',address)),32,'0'))
        
        CONSTRAINT address__nodeid FOREIGN KEY nodeid (nodeid)
            REFERENCES node (nodeid)
            ON DELETE CASCADE
            ON UPDATE CASCADE
    )`,

    // Адреса, которые изменились (md5_key) - теперь они перемещаются сюда, а из adderss удаляются (nodeid + address)
    `CREATE TABLE IF NOT EXISTS address_hist (
        nodeid      INT UNSIGNED NOT NULL,
        address     CHAR(68) CHARSET ascii NOT NULL,
        last_update INT UNSIGNED NOT NULL,

        INDEX nodeid (nodeid),
        
        CONSTRAINT address_hist__nodeid FOREIGN KEY nodeid (nodeid)
            REFERENCES node (nodeid)
            ON DELETE CASCADE
            ON UPDATE CASCADE
    )`,

    // Описывает каналы, которые видны через граф сети
    // Именно наши каналы будут представлены в другой таблице (в том числи и здесь, конечно)
    // Если канал имеет pruned - тогда надо его проверить на UTXO транзакции txid (API: https://bitcoin.org/en/developer-reference#gettxout)
    `CREATE TABLE IF NOT EXISTS channel (
        channel_id  BIGINT UNSIGNED NOT NULL PRIMARY KEY,  # 8-байтовый short_id сети LN

        nodeid_1    INT UNSIGNED NOT NULL,
        nodeid_2    INT UNSIGNED NOT NULL,
        
        block_height MEDIUMINT UNSIGNED NOT NULL,
        tx_index     MEDIUMINT UNSIGNED NOT NULL,
        output_index SMALLINT  UNSIGNED NOT NULL,
        
        txid BINARY (32) NOT NULL,                       # little-endian (потому что RPC выдают такой порядок)
        
        capacity BIGINT UNSIGNED NOT NULL,
        
        pruned       BOOL NOT NULL DEFAULT FALSE,        # TRUE - значит не появляется в графах, то скорее всего закрыт

        INDEX  nodeid_1 (nodeid_1),
        INDEX  nodeid_2 (nodeid_2),
        
        INDEX txid_8 (txid(8)),
        
        CONSTRAINT channel__nodeid_1 FOREIGN KEY nodeid_1 (nodeid_1)
            REFERENCES node (nodeid)
            ON DELETE CASCADE
            ON UPDATE CASCADE,

        CONSTRAINT channel__nodeid_2 FOREIGN KEY nodeid_2 (nodeid_2)
            REFERENCES node (nodeid)
            ON DELETE CASCADE
            ON UPDATE CASCADE
    )`,

    // Те каналы, которые точно закрыты (публичные) - есть расходование funding
    // Именно наши каналы будут представлены в другой таблице (в том числи и здесь, конечно)
    `CREATE TABLE IF NOT EXISTS closed_channel (
        channel_id  BIGINT UNSIGNED NOT NULL PRIMARY KEY,  # 8-байтовый short_id сети LN

        nodeid_1    INT UNSIGNED NOT NULL,
        nodeid_2    INT UNSIGNED NOT NULL,
        
        block_height MEDIUMINT UNSIGNED NOT NULL,
        tx_index     MEDIUMINT UNSIGNED NOT NULL,
        output_index SMALLINT  UNSIGNED NOT NULL,
        
        txid BINARY (32) NOT NULL,                       # little-endian (потому что RPC выдают такой порядок)
        
        capacity BIGINT UNSIGNED NOT NULL,
        
        close_height MEDIUMINT UNSIGNED,                 # Высота закрытия, если сигнал мы получили из subscribed (иначе NULL)

        INDEX  nodeid_1 (nodeid_1),
        INDEX  nodeid_2 (nodeid_2),
        
        INDEX txid_8 (txid(8)),
        
        CONSTRAINT closed_channel__nodeid_1 FOREIGN KEY nodeid_1 (nodeid_1)
            REFERENCES node (nodeid)
            ON DELETE CASCADE
            ON UPDATE CASCADE,

        CONSTRAINT closed_channel__nodeid_2 FOREIGN KEY nodeid_2 (nodeid_2)
            REFERENCES node (nodeid)
            ON DELETE CASCADE
            ON UPDATE CASCADE
    )`,

    // Описывает каналы, которые были закрыты с нашим пулом нод (публичные)
    // Здесь только находятся дополнительные данные, так как сами каналы в closed_channel
    // Также здесь нет каналов, которые так и не были открыты (funding_canceled, abandoned)
    `CREATE TABLE IF NOT EXISTS closed_channel_with_us (
        channel_id  BIGINT UNSIGNED NOT NULL,
        
        close_type ENUM ('C', 'L', 'R', 'B') CHARSET ascii NOT NULL, # cooperative, local_force, remote_force, breach
        close_height MEDIUMINT UNSIGNED NOT NULL,
        
        settled_balance     INT UNSIGNED NOT NULL,
        time_locked_balance INT UNSIGNED NOT NULL,
        initiator           BOOL NOT NULL DEFAULT FALSE,    # Кто был инициатором

        INDEX channel_id (channel_id),
        
        CONSTRAINT closed_channel_with_us__channel_id FOREIGN KEY channel_id (channel_id)
            REFERENCES closed_channel (channel_id)
            ON DELETE CASCADE
            ON UPDATE CASCADE
    )`,

    // Эта информация доступна только нашим нодам
    `CREATE TABLE IF NOT EXISTS private_channel (
        channel_id  BIGINT UNSIGNED NOT NULL PRIMARY KEY,  # 8-байтовый short_id сети LN

        nodeid_1    INT UNSIGNED NOT NULL,
        nodeid_2    INT UNSIGNED NOT NULL,
        
        block_height MEDIUMINT UNSIGNED NOT NULL,
        tx_index     MEDIUMINT UNSIGNED NOT NULL,
        output_index SMALLINT  UNSIGNED NOT NULL,
        
        txid BINARY (32) NOT NULL,                          # little-endian (потому что RPC выдают такой порядок)
        
        capacity BIGINT UNSIGNED NOT NULL,
        initiator           BOOL NOT NULL DEFAULT FALSE,    # Кто инициатор
        
        INDEX  nodeid_1 (nodeid_1),
        INDEX  nodeid_2 (nodeid_2),
        
        INDEX txid_8 (txid(8)),
        
        CONSTRAINT private_channel__nodeid_1 FOREIGN KEY nodeid_1 (nodeid_1)
            REFERENCES node (nodeid)
            ON DELETE CASCADE
            ON UPDATE CASCADE,

        CONSTRAINT private_channel__nodeid_2 FOREIGN KEY nodeid_2 (nodeid_2)
            REFERENCES node (nodeid)
            ON DELETE CASCADE
            ON UPDATE CASCADE
    )`,

    // Закрытые приватные каналы с нашими узлами - они априори только с нами, поэтому здест также информация
    // о типе закрытия и балансах на момент закрытия
    `CREATE TABLE IF NOT EXISTS closed_private_channel (
        channel_id  BIGINT UNSIGNED NOT NULL PRIMARY KEY,  # 8-байтовый short_id сети LN

        nodeid_1    INT UNSIGNED NOT NULL,
        nodeid_2    INT UNSIGNED NOT NULL,
        
        block_height MEDIUMINT UNSIGNED NOT NULL,
        tx_index     MEDIUMINT UNSIGNED NOT NULL,
        output_index SMALLINT  UNSIGNED NOT NULL,
        
        txid BINARY (32) NOT NULL,                       # little-endian (потому что RPC выдают такой порядок)
        
        capacity     BIGINT UNSIGNED NOT NULL,
        initiator    BOOL NOT NULL DEFAULT FALSE,        # Кто был инициатором

        close_type ENUM ('C', 'L', 'R', 'B', 'F', 'A') CHARSET ascii NOT NULL, # cooperative, local_force, remote_force, breach, funding_canceled, abandoned
        close_height MEDIUMINT UNSIGNED NOT NULL,

        settled_balance INT UNSIGNED NOT NULL,
        time_locked_balance INT UNSIGNED NOT NULL,

        INDEX  nodeid_1 (nodeid_1),
        INDEX  nodeid_2 (nodeid_2),
        
        INDEX txid_8 (txid(8)),
        
        CONSTRAINT closed_private_channel__nodeid_1 FOREIGN KEY nodeid_1 (nodeid_1)
            REFERENCES node (nodeid)
            ON DELETE CASCADE
            ON UPDATE CASCADE,

        CONSTRAINT closed_private_channel__nodeid_2 FOREIGN KEY nodeid_2 (nodeid_2)
            REFERENCES node (nodeid)
            ON DELETE CASCADE
            ON UPDATE CASCADE
    )`,


    // Канал может иметь policy даже только с одной стороны, а с другой null
    // Если LND возвращает нам с какой либо стороны null - здесь запись про эту сторону (nodeid) отсутствует, или она старая
    `CREATE TABLE IF NOT EXISTS chan_policy_side (
        channel_id  BIGINT UNSIGNED NOT NULL,
        nodeid      INT UNSIGNED NOT NULL,
        
        last_update INT UNSIGNED NOT NULL,  # Берётся из данных egdes в начале, а потом обновляется при subscribe events
        
        time_lock_delta      INT UNSIGNED NOT NULL,
        min_htlc             BIGINT UNSIGNED NOT NULL,
        fee_base_msat        BIGINT UNSIGNED NOT NULL,
        fee_rate_milli_msat  BIGINT UNSIGNED NOT NULL,
        disabled             BOOL NOT NULL,
        max_htlc_msat        BIGINT UNSIGNED NOT NULL,
        
        UNIQUE channel_id_nodeid (channel_id, nodeid),
        INDEX  nodeid        (nodeid),
        
        CONSTRAINT chan_policy_side__channel_id FOREIGN KEY channel_id_nodeid (channel_id)
            REFERENCES channel (channel_id)
            ON DELETE CASCADE
            ON UPDATE CASCADE,

        CONSTRAINT chan_policy_side__nodeid FOREIGN KEY nodeid (nodeid)
            REFERENCES node (nodeid)
            ON DELETE CASCADE
            ON UPDATE CASCADE
    )
    `,


    // Исторические данные update channel для публичных каналов
    `CREATE TABLE IF NOT EXISTS chan_policy_side_hist (
        channel_id  BIGINT UNSIGNED NOT NULL,
        nodeid      INT UNSIGNED NOT NULL,
        
        last_update INT UNSIGNED NOT NULL,  # Берётся из данных egdes в начале, а потом обновляется при subscribe events
        
        time_lock_delta      INT UNSIGNED NOT NULL,
        min_htlc             BIGINT UNSIGNED NOT NULL,
        fee_base_msat        BIGINT UNSIGNED NOT NULL,
        fee_rate_milli_msat  BIGINT UNSIGNED NOT NULL,
        disabled             BOOL NOT NULL,
        max_htlc_msat        BIGINT UNSIGNED NOT NULL,
        
        UNIQUE channel_id_nodeid (channel_id, nodeid),
        INDEX  nodeid        (nodeid),
        
        CONSTRAINT chan_policy_side_hist__channel_id FOREIGN KEY channel_id_nodeid (channel_id)
            REFERENCES channel (channel_id)
            ON DELETE CASCADE
            ON UPDATE CASCADE,

        CONSTRAINT chan_policy_side_hist__nodeid FOREIGN KEY nodeid (nodeid)
            REFERENCES node (nodeid)
            ON DELETE CASCADE
            ON UPDATE CASCADE
    )
    `,

    // Все данные update channel для канала, который закрыт (публичный канал)
    `CREATE TABLE IF NOT EXISTS closed_chan_policy_side (
        channel_id  BIGINT UNSIGNED NOT NULL,
        nodeid      INT UNSIGNED NOT NULL,
        
        last_update INT UNSIGNED NOT NULL,  # Берётся из данных egdes в начале, а потом обновляется при subscribe events
        
        time_lock_delta      INT UNSIGNED NOT NULL,
        min_htlc             BIGINT UNSIGNED NOT NULL,
        fee_base_msat        BIGINT UNSIGNED NOT NULL,
        fee_rate_milli_msat  BIGINT UNSIGNED NOT NULL,
        disabled             BOOL NOT NULL,
        max_htlc_msat        BIGINT UNSIGNED NOT NULL,
        
        UNIQUE channel_id_nodeid (channel_id, nodeid),
        INDEX  nodeid        (nodeid),
        
        CONSTRAINT closed_chan_policy_side__channel_id FOREIGN KEY channel_id_nodeid (channel_id)
            REFERENCES closed_channel (channel_id)
            ON DELETE CASCADE
            ON UPDATE CASCADE,

        CONSTRAINT closed_chan_policy_side__nodeid FOREIGN KEY nodeid (nodeid)
            REFERENCES node (nodeid)
            ON DELETE CASCADE
            ON UPDATE CASCADE
    )
    `,

    `CREATE TABLE IF NOT EXISTS settings (
        dbversion   INT NOT NULL PRIMARY KEY
    )
    `
];

main();

async function main() {
    // get the client
    try {
        mysql = require('mysql2/promise')

        // create the connection
        connection = await mysql.createConnection(mysqlConnectOpts())

        if (program.recreate) {
            for (let i = tables.length - 1; i >= 0; i--) {
                let table = tables[i]
                let tableName = /^create table .*?(\w+) \(/i.exec(table)
                if (tableName && tableName[1]) {
                    console.log('drop table %s', tableName[1])
                    await connection.query('DROP TABLE IF EXISTS ??', [tableName[1]])
                }
            }
        }

        for (let table of tables) {
            debug(table)
            console.log('create table')
            await connection.execute(table)
        }

        const [rows,fields] = await connection.query('SELECT * FROM settings')
        debug("q_1: %o, %o", rows, fields)
        if (rows.length == 0) {
            await connection.execute('INSERT INTO settings SET dbversion=1')
        }

        console.log('finished sucessfully');
    }
    catch (e) {
        console.log('ERROR: %s', e.message);
        console.log('SQL: %s', e.sql || '');
    }
    finally {
        console.log('disconnected')
        connection.end()
    }
}

