import 'dotenv/config'

import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import compression from 'compression'
import { decode } from 'jsonwebtoken'

import { getToken, verifyToken, auth, setAuthCookies } from './utils/auth'

export const app = express()

//
//
// //////////////////////////////
//            Middleware
// //////////////////////////////
//
//

const AllowedOrigins = ['http://localhost:3000', 'https://boldo-web.herokuapp.com']
app.use(cors({ origin: AllowedOrigins, credentials: true }))

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

app.use(compression())

//
//
// //////////////////////////////
//            Helpers
// //////////////////////////////
//
//

//
//
// //////////////////////////////
//            ROUTES
// //////////////////////////////
//
//

app.get('/', (req, res) => res.send('<h1>Hello, nice to meet you 🤖</h1>'))

//
// AUTH:
// Routes for authentication of users
// POST /code - login with KeyCloak authorization code
// GET /refreshtoken - use refresh token to receive a new set of access and refresh token
// GET /logout - logout, clear refresh token
// GET /profile - fetch details about current user
//

// Boldo Doctor returns code and tokens are generated here
app.get('/code', async (req, res) => {
  const error = () => res.redirect(`${process.env.CLIENT_ADDRESS}/?error=Login failed`)

  let { code } = req.query

  if (!code || typeof code !== 'string') return error()

  try {
    const data = await getToken({
      client_id: 'boldo-doctor',
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${process.env.SERVER_ADDRESS}/code`,
    })

    if (!data) return error()

    const { access_token: accessToken, refresh_token: refreshToken } = data

    if (!accessToken || !refreshToken) return error()

    const jwtA = await verifyToken(accessToken)
    const jwtR = decode(refreshToken) as any

    const accessTokenExpireDate = new Date(jwtA.exp * 1000)
    const refreshTokenExpireDate = new Date(jwtR.exp * 1000)

    setAuthCookies({ res, accessToken, refreshToken, accessTokenExpireDate, refreshTokenExpireDate })

    res.redirect(`${process.env.CLIENT_ADDRESS}`)
  } catch (err) {
    console.log(err)
    return error()
  }
})

// Boldo Patient is usik PKCE flow and returns tokens already
app.post('/code', async (req, res) => {
  let { accessToken, refreshToken } = req.body

  if (!accessToken || !refreshToken) return res.sendStatus(500)

  try {
    const jwtA = await verifyToken(accessToken)
    const jwtR = decode(refreshToken) as any

    const accessTokenExpireDate = new Date(jwtA.exp * 1000)
    const refreshTokenExpireDate = new Date(jwtR.exp * 1000)

    setAuthCookies({ res, accessToken, refreshToken, accessTokenExpireDate, refreshTokenExpireDate })

    res.sendStatus(200)
  } catch (err) {
    console.log(err)
    res.sendStatus(500)
  }
})

app.get('/refreshtoken', async (req, res) => {
  const { refreshToken: oldRefreshToken } = req.cookies

  if (!oldRefreshToken) return res.sendStatus(403)
  try {
    const jwt = decode(oldRefreshToken) as any

    const data = await getToken({
      client_id: jwt['azp'],
      grant_type: 'refresh_token',
      refresh_token: oldRefreshToken,
    })

    const { access_token: accessToken, refresh_token: refreshToken } = data

    if (!accessToken || !refreshToken) return res.sendStatus(500)

    const jwtA = await verifyToken(accessToken)
    const jwtR = decode(refreshToken) as any

    const accessTokenExpireDate = new Date(jwtA.exp * 1000)
    const refreshTokenExpireDate = new Date(jwtR.exp * 1000)

    setAuthCookies({ res, accessToken, refreshToken, accessTokenExpireDate, refreshTokenExpireDate })

    res.sendStatus(200)
  } catch (err) {
    console.log(err)
    return res.sendStatus(500)
  }
})

app.get('/logout', (req, res) => {
  res.sendStatus(200)
})

app.get('/profile', auth(['doctor']), (req, res) => {
  res.send({ type: res.locals.type, id: res.locals.userId })
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
