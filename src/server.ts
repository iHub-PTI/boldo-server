import 'dotenv/config'

import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import compression from 'compression'
import { decode } from 'jsonwebtoken'

import { getToken, verifyToken } from './utils/auth'

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

type UserType = 'doctor' | 'patient'

//
// Authentication
//
export const auth = (roles?: UserType[]) => {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    //get the accesss token
    const token = req.cookies['accessToken']

    if (!token || typeof token !== 'string') {
      return res.sendStatus(401)
    }
    try {
      const jwt: any = await verifyToken(token)
      if (!jwt || (roles && !roles.map(userType => `boldo-${userType}`).includes(jwt.azp))) return res.sendStatus(401)
      res.locals.userId = jwt.preferred_username
      res.locals.type = jwt.azp.replace('boldo-', '')
    } catch (err) {
      // console.log(err) // ommit as it shows errors if token is expired
      return res.sendStatus(401)
    }

    next()
  }
}

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

const returnRedirect = (res: express.Response, type: 'success' | 'error') => {
  if (type === 'success') res.redirect(`${process.env.CLIENT_ADDRESS}`)
  else if (type === 'error') res.redirect(`${process.env.CLIENT_ADDRESS}/?error=Login failed`)
  else res.sendStatus(500)
}

const returnStatus = (res: express.Response, type: 'success' | 'error') => {
  if (type === 'success') res.sendStatus(200)
  else if (type === 'error') res.sendStatus(400)
  else res.sendStatus(500)
}

app.get('/code', async (req, res) => {
  let { accessToken, refreshToken } = req.body
  let { code } = req.query

  let returnType = returnStatus

  // Boldo Patient is usik PKCE flow and returns tokens already
  // Boldo Doctor returns code and tokens are generated here
  if (code && typeof code === 'string') {
    returnType = returnRedirect

    try {
      const data = await getToken({
        client_id: 'boldo-doctor',
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${process.env.SERVER_ADDRESS}/code`,
      })

      accessToken = data.access_token
      refreshToken = data.refresh_token
    } catch (err) {
      console.log(err)
      returnType(res, 'error')
    }
  }

  if (accessToken && refreshToken) {
    try {
      const jwtA = await verifyToken(accessToken)
      res.cookie('accessToken', accessToken, {
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : undefined,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        expires: new Date(Date.now() + (jwtA.exp - jwtA.iat) * 1000),
        path: '/',
      })

      const jwtR = decode(refreshToken) as any
      res.cookie('refreshToken', refreshToken, {
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : undefined,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        expires: new Date(Date.now() + (jwtR.exp - jwtR.iat) * 1000),
        path: '/refreshtoken',
      })
      returnType(res, 'success')
    } catch (err) {
      console.log(err)
      returnType(res, 'error')
    }
  } else {
    returnType(res, 'error')
  }
})

app.get('/refreshtoken', (req, res) => {
  res.sendStatus(200)
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
