/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const debug = require('debug')('lnbig:apidatacache')

module.exports = class APIDataCache {
    constructor(name, funcData, expires, storage) {
        this.name = name
        this.funcData = funcData
        this.expires = expires
        this.storage = storage
        this.lastPromise = null
        this.load = false
    }

    async data() {
        let res
        if (! ( res = await this.storage.getItem(this.name)) ) {
            debug("Элемент %s отсутствует в кеше", this.name)
            // Нет - значит кеш истёк - тогда кто первый - тот и вытягивает, а остальные получают старый результат
            if (! this.lastPromise || ! this.load) {
                debug("Загружаем данные %s", this.name)
                this.load = true
                this.lastPromise = ( async () => {
                    // TODO Добавить блок обработки исключений и отправлять ошибку на клиент, если какие либо проблемы
                    try {
                        res = await this.funcData()
                        debug("Данные загружены (%s) - сохраняем в кеше", this.name)
                        await this.storage.setItem(this.name, res, {ttl: this.expires})
                    }
                    finally {
                        this.load = false
                    }
                    return res
                })()
            }
            // Если уже данные загружаются - работаем со старой версией, если она есть, конечно
            debug("Ожидаем исполнения %s", this.name)
            res = await this.lastPromise
        }
        else {
            debug("Данные (%s) в кеше - выдаём их", this.name)
        }
        return res
    }
}
