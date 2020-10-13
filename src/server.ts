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
//            TOKENS
// //////////////////////////////
//
//


app.get('/', (req, res) => res.send('Hello. Nice to meet you 🤖.'))

const PORT = process.env.PORT || 4000
httpServer.listen(PORT, () => console.info(`Running on ${PORT}`))