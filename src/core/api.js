import cors from "cors";
import rateLimit from "express-rate-limit";
import { randomBytes } from "crypto";

const ipSalt = randomBytes(64).toString('hex');

import { env, version } from "../modules/config.js";
import match from "../modules/processing/match.js";
import { languageCode } from "../modules/sub/utils.js";
import { createResponse, verifyRequest, getIP } from "../modules/processing/request.js";
import { Bright, Cyan } from "../modules/sub/consoleText.js";
import stream from "../modules/stream/stream.js";
import loc from "../localization/manager.js";
import { generateHmac } from "../modules/sub/crypto.js";
import { verifyStream, getInternalStream } from "../modules/stream/manage.js";
import { extract } from "../modules/processing/url.js";

export function runAPI(express, app, gitCommit, gitBranch, __dirname) {
    const corsConfig = env.corsWildcard ? {} : {
        origin: env.corsURL,
        optionsSuccessStatus: 200
    };

    const apiLimiter = rateLimit({
        windowMs: 60000,
        max: 20,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: req => generateHmac(getIP(req), ipSalt),
        handler: (req, res) => {
            return res.status(429).json({
                "status": "rate-limit",
                "text": loc(languageCode(req), 'ErrorRateLimit')
            });
        }
    })

    const apiLimiterStream = rateLimit({
        windowMs: 60000,
        max: 25,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: req => generateHmac(getIP(req), ipSalt),
        handler: (req, res) => {
            return res.sendStatus(429)
        }
    })
    
    const startTime = new Date();
    const startTimestamp = startTime.getTime();

    app.set('trust proxy', ['loopback', 'uniquelocal']);

    app.use('/api/:type', cors({
        methods: ['GET', 'POST'],
        ...corsConfig
    }))

    app.use('/api/json', apiLimiter);
    app.use('/api/stream', apiLimiterStream);
    app.use('/api/onDemand', apiLimiter);

    app.use((req, res, next) => {
        try { decodeURIComponent(req.path) } catch (e) { return res.redirect('/') }
        next();
    })

    app.use('/api/json', express.json({
        verify: (req, res, buf) => {
            const acceptHeader = String(req.header('Accept')) === "application/json";
            if (acceptHeader) {
                if (buf.length > 720) throw new Error();
                JSON.parse(buf);
            } else {
                throw new Error();
            }
        }
    }))

    // handle express.json errors properly (https://github.com/expressjs/express/issues/4065)
    app.use('/api/json', (err, req, res, next) => {
        let errorText = "invalid json body";
        const acceptHeader = String(req.header('Accept')) !== "application/json";

        if (err || acceptHeader) {
            if (acceptHeader) errorText = "invalid accept header";
            return res.status(400).json({
                status: "error",
                text: errorText
            });
        } else {
            next();
        }
    })

    const acceptRegex = /^application\/json(; charset=utf-8)?$/;

    app.post('/api/json', async (req, res) => {
        const request = req.body;
        const lang = languageCode(req);

        const fail = (t) => {
            const { status, body } = createResponse("error", { t: loc(lang, t) });
            res.status(status).json(body);
        }

        if (!acceptRegex.test(req.header('Content-Type'))) {
            return fail('ErrorInvalidContentType');
        }

        if (!request.url) {
            return fail('ErrorNoLink');
        }

        request.dubLang = request.dubLang ? lang : false;
        const normalizedRequest = verifyRequest(request);
        if (!normalizedRequest) {
            return fail('ErrorCantProcess');
        }

        const parsed = extract(normalizedRequest.url);
        if (parsed === null) {
            return fail('ErrorUnsupported');
        }

        try {
            const result = await match(
                parsed.host, parsed.patternMatch, lang, normalizedRequest
            );

            res.status(result.status).json(result.body);
        } catch {
            fail('ErrorSomethingWentWrong');
        }
    })

    app.get('/api/stream', (req, res) => {
        const id = String(req.query.id);
        const exp = String(req.query.exp);
        const sig = String(req.query.sig);
        const sec = String(req.query.sec);
        const iv = String(req.query.iv);

        const checkQueries = id && exp && sig && sec && iv;
        const checkBaseLength = id.length === 21 && exp.length === 13;
        const checkSafeLength = sig.length === 43 && sec.length === 43 && iv.length === 22;

        if (checkQueries && checkBaseLength && checkSafeLength) {
            // rate limit probe, will not return json after 8.0
            if (req.query.p) {
                return res.status(200).json({
                    status: "continue"
                })
            }
            try {
                const streamInfo = verifyStream(id, sig, exp, sec, iv);
                if (!streamInfo?.service) {
                    return res.sendStatus(streamInfo.status);
                }
                return stream(res, streamInfo);
            } catch {
                return res.destroy();
            }
        }
        return res.sendStatus(400);
    })

    app.get('/api/istream', (req, res) => {
        try {
            if (!req.ip.endsWith('127.0.0.1'))
                return res.sendStatus(403);
            if (String(req.query.id).length !== 21)
                return res.sendStatus(400);

            const streamInfo = getInternalStream(req.query.id);
            if (!streamInfo) return res.sendStatus(404);
            streamInfo.headers = req.headers;

            return stream(res, { type: 'internal', ...streamInfo });
        } catch {
            return res.destroy();
        }
    })

    app.get('/api/serverInfo', (req, res) => {
        try {
            return res.status(200).json({
                version: version,
                commit: gitCommit,
                branch: gitBranch,
                name: env.apiName,
                url: env.apiURL,
                cors: Number(env.corsWildcard),
                startTime: `${startTimestamp}`
            });
        } catch {
            return res.destroy();
        }
    })

    app.get('/api/status', (req, res) => {
        res.status(200).end()
    })

    app.get('/favicon.ico', (req, res) => {
        res.sendFile(`${__dirname}/src/front/icons/favicon.ico`)
    })

    app.get('/*', (req, res) => {
        res.redirect('/api/serverInfo')
    })

    app.listen(env.apiPort, env.listenAddress, () => {
        console.log(`\n` +
            `${Cyan("cobalt")} API ${Bright(`v.${version}-${gitCommit} (${gitBranch})`)}\n` +
            `Start time: ${Bright(`${startTime.toUTCString()} (${startTimestamp})`)}\n\n` +
            `URL: ${Cyan(`${env.apiURL}`)}\n` +
            `Port: ${env.apiPort}\n`
        )
    })
}
