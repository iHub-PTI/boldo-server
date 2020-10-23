import 'dotenv/config'

import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import compression from 'compression'
import session from 'express-session'
import Keycloak from 'keycloak-connect'

import { createLoginUrl } from './util/kc-helpers'

import axios from 'axios'
axios.defaults.baseURL = process.env.IHUB_ADDRESS!

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

//
//
// //////////////////////////////
//            Keycloak
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
app.use(session({ secret: process.env.SECRET!, resave: false, saveUninitialized: true, store: memoryStore }))

// FIXME: We should try if we can configure KC with cookies instead of sessions
// FIXME: Enable offline_acess scope and make sure we make use of it
// BUT: Offline Scope might not be the best to add for doctors as they would essentially be constantly logged in.
// Better to find a way in the client to keep the doctor logged in while using the app?
export const keycloak = new Keycloak(
  {
    store: memoryStore,
    //scope: 'offline_access',
  },
  kcConfig
)

app.set('trust proxy', true)
app.use(keycloak.middleware())

//
//
// //////////////////////////////
//            ROUTES
// //////////////////////////////
//
//

app.get('/', (req, res) => {
  res.send('<h1>Hello, nice to meet you 🤖</h1>')
})

app.get('/me', (req, res) => {
  const kauth = (req as any).kauth

  if (kauth && kauth.grant) {
    return res.format({
      html: () => res.redirect('http://localhost:3000'),
      json: () =>
        res.send({ type: 'string', id: 'string', name: 'string', email: kauth?.grant.access_token?.content?.email }),
    })
  }

  res.status(401).send({ message: createLoginUrl(req) })
})

//
// DOCTORS:
// Routes for public doctor profile information
// POST /doctors - Fetch all doctors
//

app.get('/doctors', async (req, res) => {
  try {
    const resp = await axios.get('/doctors')
    res.send({ doctors: resp.data })
  } catch (err) {
    console.log(err)
    res.status(400).send({ message: 'Failed to fetch data' })
  }
})

//
// PROFILE:
// Protected Routes for managing profile information
// GET /profile/doctor - Read doctor details
// POST /profile/doctor - Update doctor details
//

app.get('/profile/doctor', keycloak.protect(), async (req, res) => {
  try {
    const kauth = (req as any).kauth
    console.log(kauth?.grant.access_token.token)
    const resp = await axios.get('/profile/doctor', {
      headers: {
        Authorization: `Bearer ${kauth?.grant.access_token.token}`,
      },
    })
    console.log(resp.data)
    res.send('Hello world')
  } catch (err) {
    console.log(err)
    res.status(400).send({ message: 'Failed to fetch data' })
  }
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
