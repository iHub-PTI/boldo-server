import axios from 'axios'
import { addDays, differenceInDays } from 'date-fns'
import express from 'express'

import { createLoginUrl } from './kc-helpers'
import calculateOpenIntervals from '../../worker/getOpenIntervals'
import Appointment from '../models/Appointment'
import Doctor, { IDoctor } from '../models/Doctor'

type Interval = [number, number]

const APPOINTMENT_LENGTH = 30 /**minutes in milliseconds*/ * 1000 * 60

export const calculateAvailability = async (doctorId: string, start: Date, end: Date) => {
  try {
    // Get the doctor._id and opening hours
    const doctor = await Doctor.findOne({ id: doctorId })
    if (!doctor) throw { message: 'Booking not available', status: '400' }

    const openHours = doctor.openHours || { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }

    // Get all the FHIR appointments
    const resp = await axios.get<iHub.Appointment[]>(
      `/appointments?doctors=${doctorId}&start=${start.toISOString()}&end=${end.toISOString()}`
    )

    // Get the doctors other appointments
    const appointments = await Appointment.find({ doctorId: doctor._id, end: { $gt: start }, start: { $lt: end } })

    // Transforming the data
    const iHubAppointments = resp.data.map(appointment => [Date.parse(appointment.start), Date.parse(appointment.end)])
    const boldoAppointments = appointments.map(appointment => [appointment.start.getTime(), appointment.end.getTime()])
    const blockedIntervals = [...boldoAppointments, ...iHubAppointments] as Interval[]

    // Expand openingHours to intervals
    const openHourDates = calculateOpenHours(openHours, start, end) as Interval[]

    // Calcualte availability intervals
    const openIntervals = await calculateOpenIntervals({ base: openHourDates, substract: blockedIntervals })

    // Slize availabilities into junks of appointment lengths
    const availabilities = openIntervals
      .flatMap(interval => {
        const intervals = [] as number[]
        let [start, end] = interval

        while (end - start >= APPOINTMENT_LENGTH) {
          intervals.push(start)
          start = start + APPOINTMENT_LENGTH
        }
        return intervals
      })
      .sort((a, b) => a - b)
      .map(date => new Date(date))
      .filter(date => date > start && date <= end)
      .map(date => date.toISOString())

    return availabilities
  } catch (err) {
    throw err
  }
}

const calculateOpenHours = (openHours: IDoctor['openHours'], start: Date, end: Date) => {
  // Create list of days
  const days = differenceInDays(end, start)
  const daysList = [...Array(days + 1).keys()].map(i => addDays(start, i))
  return daysList.flatMap(day => {
    const dayOfTheWeek = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day.getDay()] as keyof IDoctor['openHours']
    const openHoursOfDay = openHours[dayOfTheWeek]

    return openHoursOfDay.map(openHour => {
      let localDateString = new Date(day).toLocaleString('en-US', { timeZone: 'America/Asuncion' })

      let localStartDate = new Date(localDateString)
      localStartDate.setHours(0, openHour.start, 0)

      let localEndDate = new Date(localDateString)
      localEndDate.setHours(0, openHour.end, 0)

      return [localStartDate.getTime(), localEndDate.getTime()]
    })
  })
}

export const handleError = (req: express.Request, res: express.Response, err: any) => {
  console.log(err.message, err.name)
  if (err.status) {
    return res.status(err.status).send({ message: err.message })
  } else if (err.isAxiosError) {
    if (err.response.status === 401) return res.status(401).send({ message: createLoginUrl(req, '/login') })
    console.log('axios:', err.response.data || err.message)
    return res.status(err.response.status).send(err.response.data)
  } else {
    console.log(err)
    return res.sendStatus(500)
  }
}
