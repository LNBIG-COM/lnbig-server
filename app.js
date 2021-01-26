/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

// Должен быть первым - загружает переменные
require('dotenv').config()
process.umask(0o77);

const nodeStorage = require('./global/nodeStorage');
const chat = require('./global/chat');
const clientStorage = require('./global/clientStorage');

const Koa = require('koa');
const Router = require('koa-router');
const bech32 = require('bech32');
const websockify = require('koa-websocket');
const debug = require('debug')('lnbig:app')

const port = process.env.LISTEN_PORT || 3000
const app = websockify(new Koa())

const httpRouter = new Router()
const wsRouter = new Router()

if (!process.env.BASE_STORAGE_DIR)
    throw Error('Not defined BASE_STORAGE_DIR env!')

// Websocket router
require('./routes/WebSocket')(wsRouter, '/ws')

// шаг 1 - GET запрос для фомирования JSON структуры для открытия канала
require('./routes/GetLNURL')(httpRouter, '/lnurl');

// шаг 1 - GET запрос callback для открытия канала
require('./routes/OpenChannel')(httpRouter, '/oc');

// шаг 2 - получаем 33-байтный nodeid, проверяем его по нодам на лимиты и после либо создаём, либо отказываем
// Пункт 6 спецификации, если ошибка: { status: "ERROR", reason: "Second level nonce not found" }
// reason может быть любой

if (process.env.CRYPT_PASSWORD) {
    // The password for crypted macaroon files in env settings (.env file for example)
    startServer(process.env.CRYPT_PASSWORD)
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
            startServer(password);
        }
    )
}

async function startServer(password) {
    // To create object for node storage

    // load node storage data included crypted macaroon files, and decrypt macaroon files by password. After the password to be cleaned from memory
    await nodeStorage.init(require('./global/nodesInfo'), password);

    // To connect to nodes
    await nodeStorage.connect()
    await clientStorage.init()
    await chat.load()

    // It's test of bech32 decryption
    debug('The test of bech32: %s', String.fromCharCode.apply(String, bech32.fromWords(bech32.decode('LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS', 1023).words)))

    // The registration of HTTP routes
    app.use(httpRouter.routes()).use(httpRouter.allowedMethods());

    // The registration of WebSocket routes
    app.ws.use(wsRouter.routes()).use(wsRouter.allowedMethods());

    // Start application...
    app.listen(port, () => console.log(`Example app listening on port ${port}!`))
}
