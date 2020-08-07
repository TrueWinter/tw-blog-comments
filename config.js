var config = {
	recaptchaSecret: '***REMOVED***',
	pushover: {
		user: '***REMOVED***',
		token: '***REMOVED***'
	},
	discordWebhook: '***REMOVED***',
	akismet: {
		key: '***REMOVED***',
		blog: 'https://blog.truewinter.dev'
	},
	mongo: {
		dev: {
			uri: '***REMOVED***',
			dbName: 'tw-comments-02-dev'
		},
		prod: {
			uri: '***REMOVED***',
			dbName: 'tw-comments-01'
		}
	},
	sendgrid: {
		apiKey: '***REMOVED***',
		from: 'noreply@e.truewinter.dev',
		to: 'nicholis@truewinter.dev'
	},
	apiURL: {
		dev: 'http://127.0.0.1:8804',
		prod: 'https://comments-api.truewinter.dev'
	},
	logins: {
		dev: {
			'nicholis': 'devpass'
		},
		prod: {
			'nicholis': '***REMOVED***'
		}
	},
	pagination: {
		enabled: true,
		perPage: 5
	}
};

module.exports = config;