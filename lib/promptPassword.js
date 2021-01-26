/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

module.exports = async function (asyncFunc) {
    if (process.env.CRYPT_PASSWORD) {
        // The password for crypted macaroon files in env settings (.env file for example)
        await asyncFunc(process.env.CRYPT_PASSWORD)
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
            async (error, password) => {
                if (error)
                    throw new Error(error);
                await asyncFunc(password);
            }
        )
    }
}
