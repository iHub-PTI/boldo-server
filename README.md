# Boldo - Server

Boldo can be found in any Paraguayan household. It is a magic tea that can calm all kind of stomachache.

This is the server for Boldo - a telemedicine solution for doctors and patients.

The server exposes APIs that are consumed by the web app and the mobile app.

## Getting Started

1. This project has the following dependencies:

   - node.js (v12 or newer)
   - mongoDB (v4.2 or newer)
   - Redis
   - Optional dependency:
     - Docker (v19 or newer) for building the image

2. Install dependencies: `npm i`

3. Create a `.env` file in the project's root folder and add these contents:

   ```
   SECRET = Secure Secret for Sessions
   MONGODB_URI = mongodb://localhost:27017/boldo
   REDIS_URL = 127.0.0.1:6379
   PRIVATE_KEY = RSA256 Private Key (e.g. `-----BEGIN RSA PRIVATE KEY-----\nMI...`)

   IHUB_ADDRESS = https://sso-test.pti.org.py/api

   # ###################### Online ######################
   # CLIENT_ADDRESS = https://boldo.penguin.software
   KEYCLOAK_ADDRESS = https://sso-test.pti.org.py/auth

   # ###################### Local ######################
   CLIENT_ADDRESS = http://localhost:3000
   # KEYCLOAK_ADDRESS = http://localhost:8080/auth
   ```

4. Ensure the server runs in the timezone `America/Asuncion`!

5. `npm run dev` - to start server on [localhost:8008](http://localhost:8008)

## Run with docker

To build the docker image use the following command:

```
docker build -t boldo-server .
```

Remember to set your `.env` file.

After that you can test it running the following command:

```bash
docker run --rm -it -p 8008:8008 boldo-server
```

## Data

This project has several scripts to run migrations or timed jobs. Have a look at [DATA](/DATA.md) to learn more.

## Contributing

The project is currently under heavy development but contributors are welcome. For bugs or feature requests or eventual contributions, just open an issue. Contribution guidelines will be available shortly.

## Authors and License

This project was created as part of the iHub COVID-19 project in collaboration between [Penguin Academy](https://penguin.academy) and [PTI (Parque Tecnológico Itaipu Paraguay)](http://pti.org.py).

This project is licensed under
[AGPL v3](LICENSE)
