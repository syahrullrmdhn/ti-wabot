const mysql = require('mysql2/promise');

const db = mysql.createPool({
    host: '103.130.198.26',  
    port: 8002,              
    user: 'networkdashboard',            
    password: 'networkdashboard2025',  
    database: 'db_bot_kampus',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = db;