var uuid = require('uuid');
var md5 = require('md5');
var xss = require('xss');
var moment = require('moment');
var isBase64 = require('is-base64');
var base64 = require("js-base64");
var GoogleRecaptcha = require('google-recaptcha');
var cors = require('cors');
var fs = require('fs');
var cookieParser = require('cookie-parser');
var Push = require('pushover-notifications');
var AkismetClient = require('akismet-api').AkismetClient;
var Webhook = require('discord-webhook-node').Webhook;
var sanitize = require('mongo-sanitize');
var express = require('express');
var config = require('./config.js');
var app = express();

app.use(express.urlencoded({ extended: true })); // for parsing application/x-www-form-urlencoded
app.use(cors());
app.use(cookieParser());

var loginCookies = fs.readFileSync('./login-cookies.json');

const googleRecaptcha = new GoogleRecaptcha({secret: config.recaptchaSecret});

var p = new Push( {
	user: config.pushover.user,
	token: config.pushover.token
});

var hook = new Webhook(config.discordWebhook);

function sendWebhook(message) {
	hook.send(message);
}

const spamClient = new AkismetClient({ key: config.akismet.key, blog: config.akismet.blog });

spamClient.verifyKey().then(function(isValid) {
	if (isValid) {
		console.log('Valid key!')
	} else {
		console.log('Invalid key!')
	}
}).catch(function(err) {
	console.error('Could not reach Akismet:', err.message);
});

var dev = fs.existsSync('./-DEV');

if (dev) {
	console.warn('Running in dev mode');
}

const MongoClient = require('mongodb').MongoClient;

var uri;
var dbName;

if (dev) {
	console.log('dev');
	uri = config.mongo.dev.uri;
	dbName = config.mongo.dev.dbName;
} else {
	console.log('prod');
	uri = config.mongo.prod.uri;
	dbName = config.mongo.prod.dbName;
}
// Open 1 connection for whole app
var client;
MongoClient.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true }, function (err, db) { // useUnifiedTopology: true added due to deprecation warning
	if (err) {
		throw new Error(err);
	}
	
	client = db;
	
	app.listen(8804, function() {
		console.log('Listening on port 8804');
	});
});

const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(config.sendgrid.apiKey);
var sgFrom = config.sendgrid.from;
var sgTo = config.sendgrid.to;

function sendMail(options) {
	if (!options) return console.error('No options');
	if (typeof options !== 'object') return console.error('Options must be an object');
	if (!(options.id && options.name && options.name && options.comment && options.time)) return console.error('Required options not provided');
	
	var id = options.id;
	var type = 'comment';
	var typeText = 'comment';
	
	if (options.in_reply_to) {
		id = `${options.id} (R: ${options.in_reply_to})`;
		type = 'reply';
		typeText = `reply to ${options.in_reply_to}`;
	}
	
	var template = `<h1>New comment</h1><hr><h3>A new ${typeText} on ${options.post} was posted.</h3><br>Name: ${options.name}<br>Time: ${options.time}<br>Comment: ${options.comment}<br><hr><br>If the above comment should not be allowed on the blog, delete it using <a href="https://comments-api.truewinter.dev/moderate/${type}/${options.id}">this link</a>. Ensure that you are logged in before doing this.`;
	
	const msg = {
		to: sgTo,
		from: sgFrom,
		subject: `New comment on TrueWinter blog (${id})`,
		html: template,
	};
	
	if (dev) {
		console.log('Not sending email due to dev mode');
		console.log('Email details:');
		console.log(msg);
	} else {	
		sgMail.send(msg).then(() => {}, error => {
			console.error(error);

			if (error.response) {
				console.error(error.response.body);
				var msg = {
					message: 'Sendgrid email failed to send on tw-comments-01'
				}
				 
				p.send( msg, function( err, result ) {
					if ( err ) {
						throw err
					}
				 
					console.log( result );
				});
			}
		});
	}
}


app.post('/comment', function (req, res) {
	//console.log(req.body);
	//const client = new MongoClient(uri, { useNewUrlParser: true });
	if (!(req.body.post && req.body.name && req.body.email && req.body.comment && req.body['g-recaptcha-response'])) {
		return res.json({success: false, message: 'Required data not in request'});
	}
	
	var ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
	
	const recaptchaResponse = req.body['g-recaptcha-response'];
 
	googleRecaptcha.verify({response: recaptchaResponse}, (error) => {
		if (error) {
			//return res.json({success: false, message: 'Recaptcha failed'});
		}
		
		if (req.body.comment.length > 2000) {
			return res.json({success: false, message: 'Comment too long'});
		}
		
		if (!(req.body.email.match(/^[a-zA-Z0-9-.]+@[a-zA-Z0-9-.]+\.[a-zA-Z]{2,6}$/gi))) {
			return res.json({success: false, message: 'Invalid email'});
		}
		
		if(!(req.body.name.match(/^[a-zA-Z0-9\'\- ]+$/gi))) {
			return res.json({success: false, message: 'Name does not match filter'});
		}
		
		//client.connect(err => {
			const collection = client.db(dbName).collection("comments");
			
			var document = {
				post: sanitize(xss(req.body.post)),
				id: uuid.v4(),
				name: sanitize(xss(req.body.name)),
				email_hash: md5(req.body.email),
				comment: sanitize(xss(req.body.comment)),
				time: moment().utc().format('D MMMM YYYY h:mm A Z'),
				spam: false
			};
			
			var spamCheckData = {
				ip: ip,
				useragent: req.get('User-Agent'),
				content: document.comment,
				email: req.body.email,
				name: document.name
			};
			
			if (req.body['tw-comments-login'] && loginCookies.includes(req.body['tw-comments-login'])) {
				console.log('Logged in');
				document.isTrueWinter = true;
				//spamCheckData.role = 'administrator';
			}
			
			spamClient.checkSpam(spamCheckData).then(function(isSpam) {
				//console.log(isSpam);
				if (isSpam) {
					console.log('OMG Spam!');
					document.spam = true;
					var prefix = '';
					var apiURL = config.apiURL.prod;
					if (dev) {
						apiURL = config.apiURL.dev;
						prefix = '[DEV] ';
					}
					sendWebhook(`${prefix}Comment ${document.id} marked as spam by Akismet. To mark as not spam (or to delete), click this link: ${apiURL}/moderate/comment/${document.id}`);
				}
				
				if (!isSpam) {
					sendMail({
						post: document.post,
						id: document.id,
						name: document.name,
						comment: document.comment,
						time: document.time,
					});
				}

				collection.insertOne(document).then(function() {
					console.log('data inserted');
					if (!isSpam) {
						res.json({success: true, message: 'Comment submitted'});
					} else {
						res.json({success: true, message: 'Comment submitted. It will be shown here after moderation'});
					}
					//client.close();
				}).catch(function(e) {
					console.log('Error:');
					console.log(e);
					res.json({success: false, message: 'Error while inserting data'});
					//client.close();
				});
			}).catch(function(err) {
				console.error('Something went wrong:', err.message)
				return res.json({success: false, message: 'Error in spam filter'});
			});
			
		//});
	});
});

app.post('/reply', function (req, res) {
	//console.log(req.body);
	//const client = new MongoClient(uri, { useNewUrlParser: true });
	if (!(req.body.inReplyPost && req.body.inReplyTo && req.body.inReplyRootComment && req.body['tw-rf-name'] && req.body['tw-rf-email'] && req.body['tw-rf-comment'])) {
		return res.json({success: false, message: 'Required data not in request'});
	}
	
	if (req.body['tw-rf-comment'].length > 2000) {
		return res.json({success: false, message: 'Reply too long'});
	}
	
	if (req.body['tw-rf-comment'].length > 2000) {
		return res.json({success: false, message: 'Comment too long'});
	}
	
	if (!(req.body['tw-rf-email'].match(/^[a-zA-Z0-9-.]+@[a-zA-Z0-9-.]+\.[a-zA-Z]{2,6}$/gi))) {
		return res.json({success: false, message: 'Invalid email'});
	}
	
	if(!(req.body['tw-rf-name'].match(/^[a-zA-Z0-9\'\- ]+$/gi))) {
		return res.json({success: false, message: 'Name does not match filter'});
	}
	
	var ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
	
	const collection = client.db(dbName).collection("replies");
	
	var document = {
		post: sanitize(xss(req.body.inReplyPost)),
		id: uuid.v4(),
		name: sanitize(xss(req.body['tw-rf-name'])),
		in_reply_to: sanitize(xss(req.body.inReplyTo)),
		in_reply_root_comment: sanitize(xss(req.body.inReplyRootComment)),
		email_hash: md5(req.body['tw-rf-email']),
		comment: sanitize(xss(req.body['tw-rf-comment'])),
		time: moment().utc().format('D MMMM YYYY h:mm A Z'),
		spam: false
	};
	
	var spamCheckData = {
		ip: ip,
		useragent: req.get('User-Agent'),
		content: document.comment,
		email: req.body['tw-rf-email'],
		name: document.name
	};
	
	if (req.body['tw-comments-login'] && loginCookies.includes(req.body['tw-comments-login'])) {
		document.isTrueWinter = true;
		//spamCheckData.role = 'administrator';
	}
	
	spamClient.checkSpam(spamCheckData).then(function(isSpam) {
		//console.log(isSpam);
		if (isSpam) {
			console.log('OMG Spam!');
			document.spam = true;
			var prefix = '';
			var apiURL = config.apiURL.prod;
			if (dev) {
				apiURL = config.apiURL.dev;
				prefix = '[DEV] ';
			}
			sendWebhook(`${prefix}Reply ${document.id} marked as spam by Akismet. To mark as not spam (or to delete), click this link: ${apiURL}/moderate/reply/${document.id}`);
		}
		
		if (!isSpam) {
			sendMail({
				post: document.post,
				id: document.id,
				in_reply_to: document.in_reply_to,
				name: document.name,
				comment: document.comment,
				time: document.time
			});
		}

		collection.insertOne(document).then(function() {
			console.log('data inserted');
			res.json({success: true, message: 'Comment submitted'});
		}).catch(function(e) {
			console.log('Error:');
			console.log(e);
			res.json({success: false, message: 'Error while inserting data'});
		});
	});
});

app.get('/comments/:post', function(req, res) {
	//console.log(req.cookies);
	if (!req.params.post) {
		return res.json({success: false, message: 'Post parameter required'});
	}
	if (!isBase64(req.params.post)) {
		return res.json({success: false, message: 'Post parameter not base64 encoded'});
	}

	if (req.query.page && isNaN(req.query.page)) {
		return res.status(400).json({success: false, message: 'Page query parameter is not a number'})
	}

	var pageNum = parseInt(sanitize(xss(req.query.page)));
	if (!req.query.page) pageNum = 1;
	var skip = config.pagination.perPage * (pageNum - 1);
	
	var post = sanitize(xss(base64.decode(decodeURIComponent(req.params.post))));
	
	const collection = client.db(dbName).collection("comments");

	var commentFacetData;

	if (config.pagination.enabled) {
		commentFacetData = [ { $skip: skip }, { $limit: config.pagination.perPage } ];
	} else {
		commentFacetData = [ { $skip: 0 } ];
	}

	console.log(commentFacetData);

	collection.aggregate([{ $match: { // I know there's a better way. Just couldn't figure out how to do limits (like with the above commentFacetData) with collection.find()
		spam: false,
		post: post
	  }
	}/*, { $lookup: {
		from: 'replies',
		localField: 'id',
		foreignField: 'in_reply_root_comment',
		as: 'replies'
	  }
	}*/, { $sort: {
		time: -1
	  }
	}/*, { $project: {
		id: 1,
		name: 1,
		email_hash: 1,
		comment: 1,
		time: 1,
		spam: 1,
		  replies: 
		  { 
			$filter: 
			{ 
			  input: "$replies", 
			  as: "replies", 
			  cond: { $eq: [ "$$replies.spam", false ] } 
			} 
		  } 
		}
	}, { $facet:   {
		metadata: [ { $count: "total" }, { $addFields: {
			pages: { $ceil: {$divide: [ "$total", config.pagination.perPage ] } },
			page: pageNum
		} } ],
		comments: commentFacetData
	  }
	}*/, { $facet : {
			metadata: [ { $count: "total" }, { $addFields: {
				pages: { $ceil: {$divide: [ "$total", config.pagination.perPage ] } },
				page: pageNum
			} } ],
			comments: commentFacetData
		}
	}
	]).toArray(function(err, data) {
		if (err) {
			res.json({success: false, message: 'Error while fetching data'});
			return console.log(err);
		}

		const collection2 = client.db(dbName).collection("replies");

		var commentsIDArr = [];

		function getCommentReplies() {
			if (commentsIDArr.length === 0) {
				return res.json({success: true, metadata: data[0].metadata[0], data: {comments:data[0].comments,replies:[]}});
			}

			collection2.find({ spam: false, post: post, in_reply_root_comment: { $in: commentsIDArr }}).toArray(function(err, data2) {
				if (err) {
					res.json({success: false, message: 'Error while fetching data'});
					return console.log(err);
				}

				res.json({success: true, metadata: data[0].metadata[0], data: {comments: data[0].comments, replies: data2}})

			});
		}

		if (data[0].comments.length === 0) {
			return res.json({success: true, metadata: data[0].metadata[0], data: {comments: [], replies: []}});
		}

		for (var i = 0; i < data[0].comments.length; i++) {
			commentsIDArr.push(data[0].comments[i].id);
			console.log(commentsIDArr);
			if (i === (data[0].comments.length -1)) {
				console.log('done here, call function');
				getCommentReplies();
			}
		}
		
		//res.json({success: true, data: data[0]})
	});
	
	/*collection.find({ post: post, spam: false }).sort({ time: -1 }).toArray(function(err, data) {
		if (err) {
			console.log(err);
			return res.json({success: false, message: 'Error while fetching data'});
		}
		//console.log(data);
		const collection2 = client.db(dbName).collection("replies");
	
		collection2.find({ post: post, spam: false }).toArray(function(err, data2) {
			if (err) {
				console.log(err);
				return res.json({success: false, message: 'Error while fetching data'});
			}
			//console.log(data2);
			res.json({success: true, data: {comments: data, replies: data2}});
		});
	});*/
	
});


app.get('/count', function(req,res) {
	var commentArr = [];
	
	const collection = client.db(dbName).collection("comments");
	
	collection.aggregate(
		{ $match : { spam: false } },
		{ $group: { "_id": "$post", "count": { $sum: 1 } } }, 
		{ $project: { "post": "$_id", "count": 1 } }
	).toArray(function(err, data) {
		if (err) {
			res.json({success: false, message: 'Error while fetching data'});
			return console.log(err);
		}
		//console.log(data);
		commentArr = data;
		
		const collection2 = client.db(dbName).collection("replies");
	
		collection2.aggregate(
			{ $match : { spam: false } },
			{ $group: { "_id": "$post", "count": { $sum: 1 } } }, 
			{ $project: { "post": "$_id", "count": 1 } }
		).toArray(function(err2, data2) {
			if (err2) {
				res.json({success: false, message: 'Error while fetching data'});
				return console.log(err2);
			}
			
			if (data.length === 0 && data2.length === 0) {
				return res.json({success: true, data: []});
			}
			//console.log(data2);
			//commentArr = data;
			for (var j = 0; j < data.length; j++) {
				for (var i = 0; i < data2.length; i++) {
					if (data[j]._id === data2[i]._id) {
						commentArr[j].count += data2[i].count;
					}
					if ((j === commentArr.length - 1) && (i === data2.length - 1)) {
						res.json({success: true, data: commentArr});
					}
				}
			}
		});
	});
});

var logins;

if (dev) {
	logins = config.logins.dev;
} else {
	logins = config.logins.prod;
}
app.get('/login', function(req, res) {
	if (req.cookies['tw-comments-login'] && loginCookies.includes(req.cookies['tw-comments-login'])) return res.end('Already logged in');
	res.set('Content-Type', 'text/html');
	res.end('<form method="post"><input type="text" name="username" placeholder="Username"><br><input type="password" name="password" placeholder="Password"><br><button type="submit">Login</button></form>');
});

app.post('/login', function(req, res) {
	if (req.cookies['tw-comments-login'] && loginCookies.includes(req.cookies['tw-comments-login'])) return res.end('Already logged in');
	if (logins[req.body.username] && logins[req.body.username] === req.body.password) {
		const cookieValue = md5(uuid.v4())+md5(uuid.v4())+md5(uuid.v4());
		if (dev) {
			res.cookie('tw-comments-login', cookieValue, { expires: new Date(Date.now() + 5000000000) });
		} else {
			res.cookie('tw-comments-login', cookieValue, { domain: '.truewinter.dev', expires: new Date(Date.now() + 5000000000) });
		}
		var lCTmp = JSON.parse(loginCookies);
		//console.log(lCTmp);
		lCTmp.push(cookieValue);
		//console.log(lCTmp);
		fs.writeFileSync('./login-cookies.json', JSON.stringify(lCTmp));
		loginCookies = fs.readFileSync('./login-cookies.json');
		res.end('OK');
	} else {
		res.status(401).end('Incorrect login');
	}
});

var csrfTokens = {}; // loginCookie + id: randomString

function generateCSRFToken(cookie, id, action) {
	csrfTokens[(cookie+'-'+id+'-'+action)] = md5(uuid.v4())+md5(uuid.v4())+md5(uuid.v4());
	console.log(csrfTokens);
	return csrfTokens[cookie+'-'+id+'-'+action];
}

function verifyCSRFToken(cookie, id, action, token) {
	if (csrfTokens[(cookie+'-'+id+'-'+action)] && csrfTokens[(cookie+'-'+id+'-'+action)] === token) {
		for (var prop in csrfTokens) {
			if (prop.startsWith(cookie+'-'+id)) {
				delete csrfTokens[prop];
				console.log(csrfTokens);
			}
		}
		delete csrfTokens[cookie+'-'+id+'-'+action]; 
		return true;
	} else {
		return false;
	}
}

app.get('/moderate/:type/:id', function (req, res) {
	if (!(req.cookies['tw-comments-login'] && loginCookies.includes(req.cookies['tw-comments-login']))) return res.status('401').end('Not logged in');
	if (!(req.params.type && req.params.id)) return res.status('400').end('Required parameters not in URL');
	
	var type = xss(req.params.type);
	var id = sanitize(xss(req.params.id));
	
	//console.log(id);
	
	// Get data from DB to display before form
	
	var col;
	
	if (req.params.type === 'comment') {
		col = 'comments';
	} else if (req.params.type === 'reply') {
		col = 'replies';
	} else {
		return res.status('400').end('Invalid type');
	}
	
	const collection = client.db(dbName).collection(col);
		
	collection.find({ id: id }).toArray(function(err, data) {
		if (err) {
			console.log(err);
			return res.json({success: false, message: 'Error while fetching data'});
		}
		
		// Return if comment is already deleted
		
		//console.log(data);
		
		if (data.length === 1) {
			if (data[0].name === '[deleted]' && data[0].comment === '[deleted]') {
				return res.end('Comment has already been deleted');
			}
			
			var notSpamBtn = '';
			if (data[0].spam) {
				notSpamBtn = `<form method="POST" action="/moderate" id="notSpamForm"><input type="hidden" name="action" value="notspam"><input type="hidden" name="type" value="${type}"><input type="hidden" name="id" value="${id}"><input type="hidden" name="csrf" value="${generateCSRFToken(req.cookies['tw-comments-login'], id, 'notspam')}"><button name="submitBtn" type="submit">Not Spam</button></form>`;
			}
			
			res.end(`<style>form {display: inline-block;margin-right: 16px;}</style><h1>Comment Moderation</h1><h3>${id}</h3><hr>Name: ${data[0].name}<br>Time: ${data[0].time}<br>Comment: ${data[0].comment}<hr><form method="POST" action="/moderate" id="deleteForm"><input type="hidden" name="action" value="delete"><input type="hidden" name="type" value="${type}"><input type="hidden" name="id" value="${id}"><input type="hidden" name="csrf" value="${generateCSRFToken(req.cookies['tw-comments-login'], id, 'delete')}"><button name="submitBtn" type="submit">Delete</button></form>${notSpamBtn}`);
		} else {
			res.end('Comment not found in database');
		}
	});
});

function deleteComment(type, id, res) {
	var col;
	if (type === 'reply') {
		col = 'replies';
	} else if (type === 'comment') {
		col = 'comments';
	} else {
		return res.status('400').end('Invalid type');
	}
	
	const collection = client.db(dbName).collection(col);
	
	const filter = { id: sanitize(id) };
	// Replace deleted comment and name with deleted message, and the email hash with the mystery person email hash. This will simplify implementation (no need to rewrite client-side JS to handle a reply to a deleted comment)
	const updateDoc = {
		$set: {
			name: '[deleted]',
			comment: '[deleted]',
			email_hash: '85433fcdac4163034baf4d9a0a8fd5cb'
		}
	};

	collection.updateOne(filter, updateDoc).then(function(result) {
		console.log(`${result.matchedCount} document(s) matched the filter, updated ${result.modifiedCount} document(s)`);
		if (result.matchedCount !== 1) {
			res.end('Delete filter didn\'t match 1 document');
		} else {
			res.end('Comment deleted');
		}
	});
}

function notSpam(type, id, res) {
	var col;
	if (type === 'reply') {
		col = 'replies';
	} else if (type === 'comment') {
		col = 'comments';
	} else {
		return res.status('400').end('Invalid type');
	}
	
	const collection = client.db(dbName).collection(col);
	
	const filter = { id: sanitize(id), spam: true };
	// Replace deleted comment and name with deleted message, and the email hash with the mystery person email hash. This will simplify implementation (no need to rewrite client-side JS to handle a reply to a deleted comment)
	const updateDoc = {
		$set: {
			spam: false
		}
	};

	collection.updateOne(filter, updateDoc).then(function(result) {
		console.log(`${result.matchedCount} document(s) matched the filter, updated ${result.modifiedCount} document(s)`);
		if (result.matchedCount !== 1) {
			res.end('Not spam filter didn\'t match 1 document');
		} else {
			res.end('Comment marked as not spam');
		}
	});
}

// Will not implement spam/ham reporting at this time. https://trello.com/c/GSNF7Ewl/21-tw-comments#comment-5f2c90a0f0f5682a071cdb66

/*function akismetSpam(type, id, res) {
	
	var col;
	
	if (type === 'comment') {
		col = 'comments';
	} else if (type === 'reply') {
		col = 'replies';
	} else {
		return res.status('400').end('Invalid type');
	}
	
	const collection = client.db(dbName).collection(col);
		
	collection.find({ id: id }).toArray(function(err, data) {
		if (err) {
			console.log(err);
			return res.json({success: false, message: 'Error while fetching data'});
		}
		
		// Return if comment is already deleted
		
		//console.log(data);
		
		if (data.length === 1) {
			if (data[0].name === '[deleted]' && data[0].comment === '[deleted]') {
				return res.end('Comment has already been deleted');
			}
			
			spamClient.submitSpam({
				user_ip: '1.1.1.1', 
				permalink: 'http://www.my.blog.com/my-post',
				comment_author: 'spammer',
				comment_content: 'that was spam but you failed to catch me'
			}, function(err) {
				console.log('Spam reported to Akismet.');
			});
			
		} else {
			res.end('Comment not found in database');
		}
	});
}*/

app.post('/moderate', function(req, res) {
	if (!(req.cookies['tw-comments-login'] && loginCookies.includes(req.cookies['tw-comments-login']))) return res.status('401').end('Not logged in');
	if (!(req.body.action && req.body.type && req.body.id && req.body.csrf)) return res.status(400).end('Required fields missing');
	if (!verifyCSRFToken(req.cookies['tw-comments-login'], req.body.id, req.body.action, req.body.csrf)) return res.status(400).end('CSRF token invalid');
	
	var actions = ['delete', 'notspam', /*'akismetham', 'akismetspam'*/];
	
	//res.end('hi');
	
	if (req.body.action === 'delete') {
		deleteComment(req.body.type, req.body.id, res);
	} else if (req.body.action === 'notspam') {
		notSpam(req.body.type, req.body.id, res);
	} else {
		res.status(400).end('Action invalid');
	}
});
