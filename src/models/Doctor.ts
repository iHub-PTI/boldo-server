import mongoose, { Schema, Document } from 'mongoose'

export interface IDoctor extends Document {
  id: string
  openHours: {
    mon: { start: number; end: number }[]
    tue: { start: number; end: number }[]
    wed: { start: number; end: number }[]
    thu: { start: number; end: number }[]
    fri: { start: number; end: number }[]
    sat: { start: number; end: number }[]
    sun: { start: number; end: number }[]
  }
}

const DoctorSchema: Schema = new Schema(
  {
    _id: String,
    id: { type: String, required: true },
    openHours: {
      mon: [{ start: Number, end: Number }],
      tue: [{ start: Number, end: Number }],
      wed: [{ start: Number, end: Number }],
      thu: [{ start: Number, end: Number }],
      fri: [{ start: Number, end: Number }],
      sat: [{ start: Number, end: Number }],
      sun: [{ start: Number, end: Number }],
    },
  },
  { timestamps: true, _id: false }
)

DoctorSchema.index({ id: 1 })

export default mongoose.model<IDoctor>('Doctor', DoctorSchema)
