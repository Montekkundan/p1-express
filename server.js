const express = require('express')
const app = express()
const axios = require('axios')
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const cors = require('cors')
const fs = require('fs');
const { Readable } = require('stream');
const {S3Client, PutObjectCommand, DeleteObjectCommand} = require('@aws-sdk/client-s3')
const OpenAI = require("openai")
const path = require('path')
const {CloudFrontClient, CreateInvalidationCommand} = require("@aws-sdk/client-cloudfront");

const dotenv = require('dotenv')

dotenv.config()

app.use(cors())

const openai = new OpenAI({
    apiKey: process.env.OPEN_AI_KEY,
});

const s3 = new S3Client({
    credentials: {
        accessKeyId: process.env.ACCESS_KEY,
        secretAccessKey: process.env.SECRET_KEY
    },
    region: process.env.BUCKET_REGION
})

const cloudFront = new CloudFrontClient({
    credentials: {
        accessKeyId: process.env.ACCESS_KEY,
        secretAccessKey: process.env.SECRET_KEY
    },
    region: process.env.BUCKET_REGION
});

const io = new Server(server, {
    cors: {
        origin: process.env.NODE_ENV === 'development' 
            ? [process.env.ELECTRON_HOST, 'http://localhost:3000']
            : [process.env.ELECTRON_HOST, process.env.NEXT_WEB_HOST],
        methods: ['GET', 'POST', 'DELETE']
    }
});

// Create temp_upload directory if it doesn't exist
const uploadDir = path.join(__dirname, 'temp_upload')
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true })
}

io.on('connection', (socket) => {
    let recordedChunks = []
    
    console.log('user connected'+ socket.id)
    socket.on('video-chunks', async (data) => {
        const writestream = fs.createWriteStream(path.join(uploadDir, data.filename))
        recordedChunks.push(data.chunks)
        const videoBlob = new Blob(recordedChunks, {type: 'video/webm; codecs=vp9'})
        const buffer = Buffer.from(await videoBlob.arrayBuffer())
        const readStream = Readable.from(buffer)

        readStream.pipe(writestream).on('finish', () => {
            console.log("chunk saved")
        })
    
    })
    socket.on('process-video', (data) => {
        recordedChunks = []
        fs.readFile(path.join(uploadDir, data.filename), async (err, file) => {

        const processing = await axios.post(`${process.env.NEXT_API_HOST}recording/${data.userId}/processing`, {
                filename: data.filename,
            })

        if(processing.data.status !== 200) return console.log("Oops! something went wrong")
            
        const Key = data.filename
        const Bucket = process.env.BUCKET_NAME
        const ContentType = 'video/webm'
        const command = new PutObjectCommand({
            Key,
            Bucket,
            ContentType,
            Body: file
        })
        const fileStatus = await s3.send(command)

        if(fileStatus['$metadata'].httpStatusCode === 200) {
            console.log("video uploaded to aws")

            //start transciption for pro plan
            //check plan serversize to stop fake client side authorization
            if(processing.data.plan === "PRO") {
                fs.stat(path.join(uploadDir, data.filename), async (err, stat) => {
                    if(!err) {
                        //wisper is restricted to 25mb uploads to avoid errors
                        //add a check for file size before transcribing
                        if(stat.size < 25000000) {
                            const transciption = await openai.audio.transcriptions.create({
                            file: fs.createReadStream(path.join(uploadDir, data.filename)),
                            model: "whisper-1",
                            response_format: "text"
                        })

                        if(transciption) {
                            const completion = await openai.chat.completions.create({
                                model: 'gpt-3.5-turbo',
                                response_format: { type: "json_object" },
                                messages: [
                                    {role: 'system', content: `You are going to generate a title and a nice description using the speech to text transcription provided: transcription(${transciption}) and then return it in json format as {"title": <the title you gave>, "summery": <the summary you created>}`}
                                ]
                            })

                            const titleAndSummeryGenerated = await axios.post(`${process.env.NEXT_API_HOST}recording/${data.userId}/transcribe`, {
                                filename: data.filename,
                                content: completion.choices[0].message.content,
                                transcript: transciption
                            })

                            if(titleAndSummeryGenerated.data.status !== 200) console.log("Oops! something went wrong")
                            }
                        }
                    }
                })
            }

            const stopProcessing = await axios.post(`${process.env.NEXT_API_HOST}recording/${data.userId}/complete`, {
                filename: data.filename,
            })

            if(stopProcessing.data.status !== 200) return console.log("Oops! something went wrong")

            if(stopProcessing.status === 200) {
                fs.unlink(path.join(uploadDir, data.filename), (err) => {
                if(!err) console.log(data.filename + ' ' + 'deleted successfully!')
            })
            }
        }
        else {
            console.log("Upload failed! process aborted")
        }
    })
    })
    socket.on("disconnect", () => {
        recordedChunks = []
        console.log(socket.id + " " + "disconnected")
    })
    socket.on('delete-video', async (data) => {
        try {
            const { filename, videoId } = data;

            // Delete from S3
            const deleteCommand = new DeleteObjectCommand({
                Bucket: process.env.BUCKET_NAME,
                Key: filename
            });

            await s3.send(deleteCommand);

            // Create CloudFront invalidation
            const invalidationCommand = new CreateInvalidationCommand({
                DistributionId: process.env.CLOUDFRONT_DISTRIBUTION_ID,
                InvalidationBatch: {
                    CallerReference: `${filename}-${Date.now()}`,
                    Paths: {
                        Quantity: 1,
                        Items: [`/${filename}`]
                    }
                }
            });

            await cloudFront.send(invalidationCommand);

            // Emit success back to client
            socket.emit('video-deleted', { success: true });

        } catch (error) {
            console.error('Error deleting video:', error);
            socket.emit('video-deleted', { success: false, error: error.message });
        }
    });
})


server.listen(5001, () => console.log('listening to port 5001'))