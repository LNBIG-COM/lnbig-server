/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

module.exports = async function (nodeStorage) {
    let data = {};
    Object.values(nodeStorage.nodes).map(item => {
        let {key, client} = item;
        if (client)
            data[key] = client.getTransactions({});
    })

    for (let key in data) {
        data[key] = await data[key];
        console.log(`Ответ getTransactions от ${key} получен`);
    }
    return data
}
