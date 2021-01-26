/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

// To see algorithm here: https://gist.github.com/LNBIG-COM/dfe5d25bcea25612c559e02fd7698660
// In this file there are many debugging info now. And russian-language comments for me

// Должен быть первым - загружает переменные
require('dotenv').config()

process.umask(0o77);
const cluster = require('cluster')

if (cluster.isMaster) {
    const { main } = require('./fillSQLGraph/Master')
    main(cluster)
}
else {
    const { main } = require('./fillSQLGraph/Worker')
    main()
}

