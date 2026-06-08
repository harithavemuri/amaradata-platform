export const testDb = {
    host:     process.env.TEST_DB_HOST     || 'localhost',
    port:     parseInt(process.env.TEST_DB_PORT || '5435'),
    database: process.env.TEST_DB_NAME     || 'amaradata-platform_test',
    user:     process.env.TEST_DB_USER     || 'postgres',
    password: process.env.TEST_DB_PASSWORD || 'AccuSync892',
};
