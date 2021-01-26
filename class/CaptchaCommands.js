/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const Commands = require('./Commands')
const debug = require('debug')('lnbig:class:commands:captcha')
const axios = require('axios')
var querystring = require('querystring');

module.exports = class CaptchaCommands extends Commands {
    constructor() {
        debug('CaptchaCommands constructor started')
        super()
        this.reCaptchaV3 = false        // Если true - значит reCaptcha v3 показала хороший результат
        this.reCaptchaV2 = false        // Если true - значит reCaptcha v2 показала хороший результат
    }

    get captchaName () { throw new Error('captchaName should be defined in class!') }

    async cmdRecaptchaV3(message) {
        // Проверяем рекапчу v3 для канала
        let res = {}

        try {
            let response = await axios.post(
                'https://www.google.com/recaptcha/api/siteverify',
                querystring.stringify(
                    {
                        secret: process.env.GOOGLE_RECAPTCHA_V3_SECRET,
                        response: message.token
                    }
                )
            );
            debug("cmdRecaptchaV3: response=%o", response)
            debug("cmdRecaptchaV3: score=%d", response.data.score)
            debug("captchaName: %o, %s", this.captchaName, this.captchaName)
            this.reCaptchaV3 = res.result = (response.data.success && response.data.action == this.captchaName && response.data.score >= 0.5)
        }
        catch (e) {
            if (e.response) {
                console.log(`reCaptcha v3 (${this.captchaName}): not 2XX status: %s`, e.response.status)
                res.error = "reCaptcha: not 2XX status"
            }
            else if (e.request) {
                console.log(`reCaptcha v3 (${this.captchaName}): google is not answered: %o`, e.request)
                res.error = "reCaptcha: API is not answered"
            }
            else {
                console.log(`reCaptcha v3 (${this.captchaName}) other error: %s`, e.message)
                res.error = "Other error"
            }
            this.reCaptchaV3 = res.result = false;
        }
        this.sendCommand(message, 'cmdRecaptchaV3', res)
    }

    async cmdRecaptchaV2(message) {
        // Проверяем рекапчу v3 для канала
        let res = {}

        try {
            let response = await axios.post(
                'https://www.google.com/recaptcha/api/siteverify',
                querystring.stringify(
                    {
                        secret: process.env.GOOGLE_RECAPTCHA_V2_SECRET,
                        response: message.token
                    }
                )
            );
            debug("cmdRecaptchaV2: response=%o", response)
            this.reCaptchaV2 = res.result = process.env.NODE_ENV === 'development' ? true : response.data.success
        }
        catch (e) {
            if (e.response) {
                console.log(`reCaptcha v2 (${this.captchaName}): not 2XX status: %s`, e.response.status)
                res.error = "reCaptcha: not 2XX status"
            }
            else if (e.request) {
                console.log(`reCaptcha v2 (${this.captchaName}): google is not answered: %o`, e.request)
                res.error = "reCaptcha: API is not answered"
            }
            else {
                console.log(`reCaptcha v2 (${this.captchaName}) other error: %s`, e.message)
                res.error = "Other error"
            }
            this.reCaptchaV2 = res.result = false;
        }
        this.sendCommand(message, 'cmdRecaptchaV2', res)
    }
}
