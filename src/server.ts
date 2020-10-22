import 'dotenv/config'

import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import compression from 'compression'
import { decode } from 'jsonwebtoken'

import session from 'express-session'
import Keycloak from 'keycloak-connect'

import { getToken, verifyToken, auth, setAuthCookies } from './utils/auth'

export const app = express()

//
//
// //////////////////////////////
//            Middleware
// //////////////////////////////
//
//

const AllowedOrigins = ['http://localhost:3000', 'https://boldo.penguin.software']
app.use(cors({ origin: AllowedOrigins, credentials: true }))

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

app.use(compression())

app.use((req, res, next) => {
  console.log(req.originalUrl)

  next()
})

//
//
// //////////////////////////////
//            Helpers
// //////////////////////////////
//
//

let kcConfig = {
  realm: 'iHub',
  'auth-server-url': process.env.KEYCLOAK_ADDRESS!,
  'ssl-required': 'external',
  resource: 'boldo-doctor',
  'public-client': true,
  'verify-token-audience': true,
  'use-resource-role-mappings': true,
  'confidential-port': 0,
}

const memoryStore = new session.MemoryStore()
app.use(
  session({
    secret: 'mySecret',
    resave: false,
    saveUninitialized: true,
    store: memoryStore,
  })
)

const keycloak = new Keycloak(
  {
    store: memoryStore,
    //scope: 'offline_access',
  },
  kcConfig
)

app.set('trust proxy', true)
app.use(keycloak.middleware())
app.use((req, res, next) => {
  if (memoryStore.all)
    memoryStore.all((err, obj) => {
      console.log(JSON.stringify(obj, null, 2))
    })
  next()
})
//
//
// //////////////////////////////
//            ROUTES
// //////////////////////////////
//
//
app.get('/code', async (req, res) => {
  let { code } = req.query

  if (!code || typeof code !== 'string') return res.sendStatus(400)

  try {
    const data = await getToken({
      client_id: 'boldo-doctor',
      grant_type: 'authorization_code',
      code,
      redirect_uri: `com.penguin.boldo:/login`,
    })

    if (!data) return res.sendStatus(400)
    console.log(data)
    res.sendStatus(200)
  } catch (err) {
    console.log(err)
    return res.sendStatus(400)
  }
})

app.get('/cookie', async (req, res) => {
  console.log(req.session)
  console.log(req.sessionID)
  res.sendStatus(200)
})

app.get('/appauth', (req, res) => {
  console.log(req.body)
  res.sendStatus(200)
  // res.redirect('http://boldo.penguin.com/login');
})

app.get('/', (req, res) => {
  console.log(req.originalUrl, 'Wow MY API')
  console.log('YES GET')

  res.send('<h1>Hello, nice to meet you 🤖</h1>')
})

app.get('/profile', keycloak.protect(), (req, res) => {
  console.log('wow we are here!')
  res.send({ type: res.locals.type, id: res.locals.userId, name: 'Björn Schmidtke', email: 'bjoern@penguin.digital' })
})

//
// DOCTORS:
// Routes for public doctor profile information
// POST /doctors - Fetch all doctors
//

app.get('/doctors', (req, res) => {
  const fakeDoctors = [
    { id: 1, name: 'Diego King' },
    { id: 2, name: 'Jorge Hoggs' },
    { id: 3, name: 'Pavel Supper' },
    { id: 4, name: 'Adam Wahn' },
    { id: 5, name: 'Josn Cena' },
    { id: 6, name: 'Alex Jenkins' },
    { id: 7, name: 'Ana Benkins' },
  ]
  res.send({ doctors: fakeDoctors })
})

//
//
// //////////////////////////////
//        START SERVER
// //////////////////////////////
//
//

const PORT = process.env.PORT || 8008
app.listen(PORT, () => console.info(`Running on ${PORT}`))
