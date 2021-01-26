/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

module.exports = async function (nodeStorage) {
    let data = {};
    Object.values(nodeStorage.nodes).map(item => {
        let {key, client} = item;
        if (client)
            data[key] = client.walletBalance({});
    })

    for (let key in data) {
        try {
            data[key] = await data[key];
            console.log(`Ответ walletBalance от ${key} получен`);
        }
        catch(e) {
            delete data[key]
            console.log(`ОШИБКА walletBalance - продолжаем (${key}): %s`, e.message)
        }
    }
    return data
}
