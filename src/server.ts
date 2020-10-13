import 'dotenv/config'

import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import compression from 'compression'
import http from 'http'
import socketIO from 'socket.io'



const AllowedOrigins = [ 'http://localhost:3000']

export const app = express()
const httpServer = new http.Server(app)
export const io = socketIO(httpServer)

//
//
// //////////////////////////////
//            Middleware
// //////////////////////////////
//
//

app.use(cors({ origin: AllowedOrigins, credentials: true }))

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

app.use(compression())

//
//
// //////////////////////////////
//            ROUTES
// //////////////////////////////
//
//

app.get('/', (req, res) => res.send('Hello. Nice to meet you 🤖.'))

app.post('/api/auth/code', (req, res) => {

  res.sendStatus(200);
})

app.get('/api/doctors', (req, res) => {
  const fakeDoctors = [
    { id: 1, name: 'Diego King' },
    { id: 2, name: 'Jorge Hoggs' },
    { id: 3, name: 'Pavel Supper' },
    { id: 4, name: 'Adam Wahn' },
    { id: 5, name: 'Josn Cena' },
    { id: 6, name: 'Alex Jenkins' },
    { id: 7, name: 'Ana Benkins' },
  ]
  res.send({ doctors: fakeDoctors });
})

const PORT = process.env.PORT || 4000
httpServer.listen(PORT, () => console.info(`Running on ${PORT}`))


