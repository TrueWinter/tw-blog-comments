var uuid = require('uuid');
var md5 = require('md5');
var xss = require('xss');
var moment = require('moment');
var isBase64 = require('is-base64');
var base64 = require("js-base64");
const GoogleRecaptcha = require('google-recaptcha');
var cors = require('cors');
var fs = require('fs');
var cookieParser = require('cookie-parser');
var express = require('express');
var app = express();

app.use(express.urlencoded({ extended: true })); // for parsing application/x-www-form-urlencoded
app.use(cors());
app.use(cookieParser());

var loginCookies = fs.readFileSync('./login-cookies.json');

const googleRecaptcha = new GoogleRecaptcha({secret: '***REMOVED***-Ak1L'});

const MongoClient = require('mongodb').MongoClient;
const uri = "mongodb+srv://tw-comments:Ts9Q6Xzm7UXaD90X@tw-comments-01.24wsr.gcp.mongodb.net/tw-comments-01?retryWrites=true&w=majority";


const sgMail = require('@sendgrid/mail');
sgMail.setApiKey('***REMOVED***');
var sgFrom = 'noreply@e.truewinter.dev';
var sgTo = '***REMOVED***';

function sendMail(options) {
	if (!options) return console.error('No options');
	if (typeof options !== 'object') return console.error('Options must be an object');
	if (!(options.id && options.name && options.name && options.comment && options.time)) return console.error('Required options not provided');
	
	var id = options.id;
	var type = 'comment';
	
	if (options.in_reply_to) {
		id = `${options.id} (R: ${options.in_reply_to})`;
		type = `reply to ${options.in_reply_to}`;
	}
	
	var template = `<h1>New comment</h1><hr><h3>A new ${type} on ${options.post} was posted.</h3><br>Name: ${options.name}<br>Time: ${options.time}<br>Comment: ${options.comment}<br><hr><br>If the above comment should not be allowed on the blog, manually delete it from the database (moderation system coming soon)`;
	
	const msg = {
		to: sgTo,
		from: sgFrom,
		subject: `New comment on TrueWinter blog (${id})`,
		html: template,
	};
	sgMail.send(msg).then(() => {}, error => {
		console.error(error);

		if (error.response) {
			console.error(error.response.body)
		}
	});
}


app.post('/comment', function (req, res) {
	//console.log(req.body);
	const client = new MongoClient(uri, { useNewUrlParser: true });
	if (!(req.body.post && req.body.name && req.body.email && req.body.comment && req.body['g-recaptcha-response'])) {
		return res.json({success: false, message: 'Required data not in request'});
	}
	
	const recaptchaResponse = req.body['g-recaptcha-response'];
 
	googleRecaptcha.verify({response: recaptchaResponse}, (error) => {
		if (error) {
			return res.json({success: false, message: 'Recaptcha failed'});
		}
		
		if (req.body.comment.length > 2000) {
			return res.json({success: false, message: 'Comment too long'});
		}
		
		client.connect(err => {
			const collection = client.db("tw-comments-01").collection("comments");
			
			var document = {
				post: xss(req.body.post),
				id: uuid.v4(),
				name: xss(req.body.name),
				email_hash: md5(req.body.email),
				comment: xss(req.body.comment),
				time: moment().utc().format('D MMMM YYYY h:mm A Z')
			};
			
			if (req.body['tw-comments-login'] && loginCookies.includes(req.body['tw-comments-login'])) {
				console.log('Logged in'); 
				document.isTrueWinter = true;
			}
			
			sendMail({
				post: document.post,
				id: document.id,
				name: document.name,
				comment: document.comment,
				time: document.time
			});

			collection.insertOne(document).then(function() {
				console.log('data inserted');
				res.json({success: true, message: 'Data inserted'});
				client.close();
			}).catch(function(e) {
				console.log('Error:');
				console.log(e);
				res.json({success: false, message: 'Error while inserting data'});
				client.close();
			});
		});
	});
});

app.post('/reply', function (req, res) {
	//console.log(req.body);
	const client = new MongoClient(uri, { useNewUrlParser: true });
	if (!(req.body.inReplyPost && req.body.inReplyTo && req.body['tw-rf-name'] && req.body['tw-rf-email'] && req.body['tw-rf-comment'])) {
		return res.json({success: false, message: 'Required data not in request'});
	}
	
	if (req.body['tw-rf-comment'].length > 2000) {
		return res.json({success: false, message: 'Reply too long'});
	}
	
	client.connect(err => {
		const collection = client.db("tw-comments-01").collection("replies");
		
		var document = {
			post: xss(req.body.inReplyPost),
			id: uuid.v4(),
			name: xss(req.body['tw-rf-name']),
			in_reply_to: xss(req.body.inReplyTo),
			email_hash: md5(req.body['tw-rf-email']),
			comment: xss(req.body['tw-rf-comment']),
			time: moment().utc().format('D MMMM YYYY h:mm A Z')
		};
		
		if (req.body['tw-comments-login'] && loginCookies.includes(req.body['tw-comments-login'])) {
			document.isTrueWinter = true;
		}
		
		sendMail({
			post: document.post,
			id: document.id,
			in_reply_to: document.in_reply_to,
			name: document.name,
			comment: document.comment,
			time: document.time
		});

		collection.insertOne(document).then(function() {
			console.log('data inserted');
			res.json({success: true, message: 'Data inserted'});
			client.close();
		}).catch(function(e) {
			console.log('Error:');
			console.log(e);
			res.json({success: false, message: 'Error while inserting data'});
			client.close();
		});
	});
	
	
	
	/*var document = {
		post: xss(req.body.post),
		id: uuid.v4(),
		name: xss(req.body.name),
		email_hash: md5(req.body.email),
		comment: xss(req.body.comment),
		time: moment().utc().format('D MMMM YYYY h:mm A Z')
	};
	
	res.json(document);*/
});

app.get('/comments/:post', function(req, res) {
	console.log(req.cookies);
	if (!req.params.post) {
		return res.json({success: false, message: 'Post parameter required'});
	}
	if (!isBase64(req.params.post)) {
		return res.json({success: false, message: 'Post parameter not base64 encoded'});
	}
	
	var post = xss(base64.decode(decodeURIComponent(req.params.post)));
	
	const client = new MongoClient(uri, { useNewUrlParser: true });
	
	client.connect(err => {
		const collection = client.db("tw-comments-01").collection("comments");
		
		collection.find({ post: post }).sort({ time: -1 }).toArray(function(err, data) {
			if (err) {
				console.log(err);
				return res.json({success: false, message: 'Error while fetching data'});
			}
			//console.log(data);
			const collection2 = client.db("tw-comments-01").collection("replies");
		
			collection2.find({ post: post }).toArray(function(err, data2) {
				if (err) {
					console.log(err);
					return res.json({success: false, message: 'Error while fetching data'});
				}
				console.log(data2);
				res.json({success: true, data: {comments: data, replies: data2}});
				//res.json({success: true, message: 'Data inserted'});
				//res.end();
				client.close();
			});
			//res.json({success: true, data: data});
			//res.json({success: true, message: 'Data inserted'});
			//res.end();
			//client.close();
		});
	});
	
});


app.get('/count', function(req,res) {
	var commentArr = [];
	const client = new MongoClient(uri, { useNewUrlParser: true });
	
	client.connect(err => {
		const collection = client.db("tw-comments-01").collection("comments");
		
		collection.aggregate(
			{ $group: { "_id": "$post", "count": { $sum: 1 } } }, 
			{ $project: { "post": "$_id", "count": 1 } }
		).toArray(function(err, data) {
			if (err) {
				res.json({success: false, message: 'Error while fetching data'});
				return console.log(err);
			}
			console.log(data);
			commentArr = data;
			
			const collection2 = client.db("tw-comments-01").collection("replies");
		
			collection2.aggregate(
				{ $group: { "_id": "$post", "count": { $sum: 1 } } }, 
				{ $project: { "post": "$_id", "count": 1 } }
			).toArray(function(err2, data2) {
				if (err2) {
					res.json({success: false, message: 'Error while fetching data'});
					return console.log(err2);
				}
				//console.log(data2);
				//commentArr = data;
				for (var j = 0; j < data.length; j++) {
					for (var i = 0; i < data2.length; i++) {
						if (data[j]._id === data2[i]._id) {
							//console.log(commentArr[j]._id);
							//console.log(data2[i]._id);
							//console.log('they equal');
							commentArr[j].count += data2[i].count;
							//console.log(commentArr);
							console.log(j);
							console.log(commentArr.length);
							console.log('-');
							console.log(i);
							console.log(data2.length);
						}
						if ((j === commentArr.length - 1) && (i === data2.length - 1)) {
							res.json({success: true, data: commentArr});
							client.close();
						}
					}
				}
			});
		});
		//res.end();
	});
});


var logins = {
	'nicholis': '***REMOVED***'
};

app.get('/login', function(req, res) {
	if (req.cookies['tw-comments-login'] && loginCookies.includes(req.cookies['tw-comments-login'])) return res.end('Already logged in');

	res.end('<form method="post"><input type="text" name="username" placeholder="Username"><br><input type="password" name="password" placeholder="Password"><br><button type="submit">Login</button></form>');
});

app.get('/login/verify/:hash', function(req, res) {
	var l = JSON.parse(loginCookies);
	res.end(l.includes(req.params.hash));
});

app.post('/login', function(req, res) {
	if (req.cookies['tw-comments-login'] && loginCookies.includes(req.cookies['tw-comments-login'])) return res.end('Already logged in');
	if (logins[req.body.username] && logins[req.body.username] === req.body.password) {
		const cookieValue = md5(uuid.v4())+md5(uuid.v4())+md5(uuid.v4());
		res.cookie('tw-comments-login', cookieValue, { domain: '.truewinter.dev', expires: new Date(Date.now() + 5000000000) });
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

app.listen(8804, function() {
	console.log('Listening on port 8804');
});
