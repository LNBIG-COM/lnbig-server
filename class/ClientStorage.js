/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const storage = require('node-persist');
const debug = require('debug')('lnbig:client-storage')
const util = require('util');
const crypto = require('crypto')
const hmac = require('../global/hmac');

class ClientStorage {
    constructor() {
        debug('process.env.BASE_STORAGE_DIR=%s', `${process.env.BASE_STORAGE_DIR}/clients`)
        this.storage = storage.create({
            dir: `${process.env.BASE_STORAGE_DIR}/clients`,
            ttl: true
        });
        this.storagePromise = this.storage.init();
    }

    async init() {
        // Persistent storage like localStorage - initialization
        return this.storagePromise;
    }

    // v2
    async createUserID(key, useUserID) {
        debug('createUserID: started async code, useUserID=%s', useUserID)
        if (!useUserID) {
            debug('generate randomBytes started')
            let value = await util.promisify(crypto.randomBytes)(8);
            debug('generate randomBytes finished')
            key = value.toString('hex');
            debug('hmac started, key=%s', key)
            let h = hmac();
            h.update(value)
            debug('hmac finished')
            useUserID = Buffer.concat([value, h.digest()]).toString('base64');
            debug('createUserID: generated key: %s, useUserID: %s', key, useUserID)
        } else {
            debug('createUserID: use ready user: key: %s, useUserID: %s', key, useUserID)
        }
        await this.storage.setItem(key, {
            key: key,
            userID: useUserID,
            firstVisit: Date.now(),
            lastVisit: Date.now(),
            restored: !!useUserID
        });
        debug('createUserID/storage - the item was stored, useUserID: %s, key: %s', useUserID, key);
        return useUserID;
    }

    async useOrCreateUserID(userIDFromUser) {
        debug('useOrCreateUserID: started async code')
        if (userIDFromUser) {
            try {
                debug('useOrCreateUserID: userIDFromUser: %s', userIDFromUser);
                let buf = Buffer.from(userIDFromUser, 'base64')
                let value = buf.slice(0, 8);
                let h = hmac();
                h.update(value)
                if (buf.slice(8).equals(h.digest())) {
                    let key = value.toString('hex');
                    // It's valid value and it was created by our server...
                    debug('useOrCreateUserID: userIDFromUser is valid (%s) and we will use it value', userIDFromUser);
                    let obj;
                    if ((obj = await this.storage.getItem(key))) {
                        debug('useOrCreateUserID: user (%s) exists, obj=%o', userIDFromUser, obj)
                        obj.lastVisit = Date.now()
                        await this.storage.setItem(key, obj)
                        return userIDFromUser
                    } else {
                        return await this.createUserID(key, userIDFromUser)
                    }
                }
            } catch (e) {
                debug('useOrCreateUserID: error (%s) in decoding userID (%s) - we will create new one', e.message, userIDFromUser);
            }
            debug('useOrCreateUserID: userIDFromUser is NOT valid (%s) - we will create new UserID', userIDFromUser);
            return await this.createUserID()
        }
    }
}

module.exports = ClientStorage;
