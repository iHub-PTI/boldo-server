# Boldo Server

## Getting Started

1. `npm i` to install dependencies

2. Create a `.env` file in the project's root folder and add these contents:

   ```
   KEYCLOAK_REALM_ADDRESS = http://localhost:8080/auth/realms/iHub
   SERVER_ADDRESS = http://localhost:8008
   CLIENT_ADDRESS = http://localhost:3000
   ```

3. `npm run dev` to start production server on [localhost:8008](http://localhost:8008)
