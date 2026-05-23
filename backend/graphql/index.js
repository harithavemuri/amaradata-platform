const { buildSchema, graphql } = require('graphql');
const typeDefs  = require('./typeDefs');
const resolvers = require('./resolvers');

const schema = buildSchema(typeDefs);

async function graphqlHandler(req, res) {
    const { query, variables, operationName } = req.body;
    if (!query) return res.status(400).json({ errors: [{ message: 'GraphQL query required' }] });
    const result = await graphql({
        schema,
        source:         query,
        variableValues: variables,
        operationName,
        contextValue:   { staff: req.staff, db: req.db },
        rootValue:      resolvers,
    });
    res.json(result);
}

module.exports = graphqlHandler;
