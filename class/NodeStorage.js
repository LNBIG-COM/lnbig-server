/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const crypto = require('crypto');
const lnd = require('lnd-async');
const debug = require('debug')('lnbig:node-storage')

class NodeStorage {
    //nodes;	// nodes - Object
    //password = '';

    constructor() {
    }

    async init(nodes, password) {
        this.nodes = nodes;
        this.password = password;

        this.decrypt();
    }

    async connect(connectOpts = {}) {
        let clients = Object.values(this.nodes).map(
            item => {
                debug(`Создание gRPC stub ${item.internalHost}`)
                return lnd.connect(Object.assign({
                    lndHost: item.internalHost,
                    lndPort: 10009,
                    cert: item.cert,
                    macaroon: item.macaroon,
                    longsAsNumbers: true
                }, connectOpts))
                    .then(client => {
                        debug(`Создан gRPC stub (${item.internalHost})`);
                        item.client = client
                        return client
                    })
                    .then( client => client.getInfo({}))
                    .catch(error => {
                        item.client = null;
                        console.error(`Ошибка (${error}) создания gRPC stub (${item.internalHost}) - временно отключаем`)
                    });
            }
        );

        debug(`clients is ${clients}`)

        let all = 1;
        for (let client of clients) {
            debug(`client of for is ${client}`)
            if (client) {
                await client;

            }
            else
                all = 0;
        }

        debug((all ? 'Все ' : 'Частично ') + "клиенты LND подключены");
    }

    decrypt() {
        for (let alias in this.nodes) {
            this.nodes[alias].key = alias;
            this.nodes[alias].macaroon = this.decryptToBase64(this.nodes[alias].macaroon);
        }
        this.erasePassword();
    }

    erasePassword() {
        process.env.CRYPT_PASSWORD = this.password = crypto.randomBytes(32).toString('base64');
    }

    decryptToBase64(encrypted) {
        let input = Buffer.from(encrypted, 'base64');

        let salt = input.slice(8, 16);
        let key = crypto.pbkdf2Sync(this.password, salt, 10000, 48, 'sha256');
        let iv = key.slice(32);
        key = key.slice(0, 32);

        let dec = crypto.createDecipheriv('aes-256-cbc', key, iv);
        return Buffer.concat([dec.update(input.slice(16)), dec.final()]).toString('base64');
    }
}

module.exports = NodeStorage
