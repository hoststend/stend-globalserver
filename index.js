// Configurer les variables d'env
require("dotenv").config()

// Variables
var reverseProxy = process.env.USING_REVERSE_PROXY === "cloudflare" ? "cloudflare" : process.env.USING_REVERSE_PROXY ? "true" : false // Si on utilise un reverse proxy, on le précise ici
var apiVersion = require("./package.json").version || "0.0.0" // Version de l'API

// Importer quelques librairies
const fastify = require("fastify")({ logger: { level: "info" }, trustProxy: !!reverseProxy })
fastify.register(require("@fastify/formbody"))
const fetch = require("node-fetch")
const removeProfanity = require("./utils/profanity")

// Supabase
var { createClient } = require("@supabase/supabase-js")
var supabase = createClient(process.env.SUPABASE_LINK, process.env.SUPABASE_PUBLIC_KEY)

// Fonction pour vérifier la distance entre deux coordonnées
function distanceGPS(lat1, lon1, lat2, lon2){
	var R = 6371 // Rayon de la Terre en km
	var dLat = (lat2 - lat1) * (Math.PI / 180)
	var dLon = (lon2 - lon1) * (Math.PI / 180)
	/* eslint-disable no-mixed-operators */
	var a =
		(Math.sin(dLat / 2) * Math.sin(dLat / 2)) +
		Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
		Math.sin(dLon / 2) * Math.sin(dLon / 2)
	/* eslint-disable no-mixed-operators */
	var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
	return R * c // Distance en km
}

// Fonction pour générer un token utilisateur
function generateRandomString(length = 8, includesUppercase = false){
	var token = ""
	var characters = "abcdefghijklmnopqrstuvwxyz0123456789"
	if(includesUppercase) characters += "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	for(var i = 0; i < length; i++) token += characters.charAt(Math.floor(Math.random() * characters.length))
	return token
}

// Obtenir les informations d'un utilisateur à partir d'une requête
async function getUserFromRequest(req){
	// Obtenir le token
	var token = req.headers.authorization
	if(!token) throw { statusCode: 401, error: "Non autorisé", message: "Vous devez être connecté pour effectuer cette action" }
	token = token.replace("Bearer ", "")

	// Obtenir l'utilisateur
	var user = await supabase.from("stendglobal-accounts").select("*").eq("token", token)
	if(user.error) throw { statusCode: 500, error: "Erreur lors de l'obtention du profil", message: `Supabase a retourné une erreur : ${user.error.message}` }
	if(!user.data.length) throw { statusCode: 401, error: "Non autorisé", message: "Votre session a expiré, vous devrez vous reconnecter", action: "DELETE_TOKEN" }
	if(!user.data[0]?.id) throw { statusCode: 500, error: "Erreur lors de l'obtention du profil", message: "Votre profil a pu être obtenu mais il semblerait que celui-ci soit invalide" }
	return user.data[0]
}

// Supprimer les transferts expirés
async function deleteExpiredTransfers(){
	// Obtenir tous les transferts
	var transfers = await supabase.from("stendglobal-transfers").select("*")
	if(transfers.error) return console.error(`(deleteExpiredTransfers) Erreur lors de l'obtention des transferts : ${transfers.error.message || transfers.error}`)
	transfers = transfers.data

	// Filtrer les transferts expirés
	console.log(`(deleteExpiredTransfers) ${transfers.length} transferts trouvés`)
	transfers = transfers.filter(transfer => parseInt(transfer.expiresDate) < new Date().getTime())
	console.log(`(deleteExpiredTransfers) ${transfers.length} transferts expirés vont être supprimés`)

	// Supprimer les transferts expirés
	for(var i = 0; i < transfers.length; i++) {
		var deleteTransfer = await supabase.from("stendglobal-transfers").delete().eq("transferId", transfers[i].transferId)
		if (deleteTransfer.error) console.error(`(deleteExpiredTransfers) Erreur lors de la suppression du transfert ${transfers[i].transferId} : ${deleteTransfer.error.message || deleteTransfer.error}`)
		else console.log(`(deleteExpiredTransfers) Le transfert ${transfers[i].transferId} a été supprimé de la BDD`)
	}

	// Log que c'est bon
	console.log("(deleteExpiredTransfers) Vérification des transferts expirés terminée")
}

// Fonction pour créer les routes
function createRoutes(){
	// Rediriger vers la documentation
	fastify.get("/", async (req, res) => {
		return res.redirect("https://stend.johanstick.fr/globalserver-docs/intro")
	})

	// Obtenir les informations de l'instance
	fastify.get("/instance", async () => {
		return { apiVersion }
	})

	// Routes liés au test des méthodes d'exposition essentielles
	fastify.get("/test/ip", async (req) => {
		return { ip: req.ip }
	})
	fastify.get("/test/distance-coordinates", async (req) => {
		// Obtenir les deux coordonnées
		["latitude1", "longitude1", "latitude2", "longitude2"].forEach((coord) => {
			if(!req.query[coord]) throw { statusCode: 400, error: "Paramètres manquants", message: `La coordonnée ${coord} est manquante` }
		})
		var latitude1 = req.query.latitude1
		var longitude1 = req.query.longitude1
		var latitude2 = req.query.latitude2
		var longitude2 = req.query.longitude2

		// Calculer la distance
		var dist = distanceGPS(latitude1, longitude1, latitude2, longitude2)
		return { distance: dist } // en km
	})

	// Routes liés à l'authentification avec Google
	fastify.get("/auth/google/login", async (req, res) => {
		// Obtenir le type de réponse à envoyer
		var responseType = req.query.responseType || "plain"
		if(!["plain", "redirect", "html"].includes(responseType)) throw { statusCode: 400, error: "Paramètres invalides", message: "Le type de réponse voulu est invalide" }

		// Rediriger
		var redirectUri = (process.env.GOOGLE_REDIRECT_URI.endsWith("/") ? process.env.GOOGLE_REDIRECT_URI : `${process.env.GOOGLE_REDIRECT_URI}/`) + responseType
		return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=profile`)
	})
	fastify.get("/auth/google/callback/:responseType", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, res) => {
		// Obtenir et vérifier le code
		var authCode = req.query.code
		if(!authCode) throw { statusCode: 400, error: "Paramètres manquants", message: "Le code est manquant" }

		// Obtenir le type de réponse à envoyer
		var responseType = req.params.responseType || "plain"
		if(!["plain", "redirect", "html"].includes(responseType)) throw { statusCode: 400, error: "Paramètres invalides", message: "Le type de réponse voulu est invalide" }

		// Générer un token
		var authToken
		try {
			var redirectUri = (process.env.GOOGLE_REDIRECT_URI.endsWith("/") ? process.env.GOOGLE_REDIRECT_URI : `${process.env.GOOGLE_REDIRECT_URI}/`) + responseType
			var tokenResponse = await fetch(`https://oauth2.googleapis.com/token?code=${authCode}&client_id=${process.env.GOOGLE_CLIENT_ID}&client_secret=${process.env.GOOGLE_CLIENT_SECRET}&redirect_uri=${redirectUri}&grant_type=authorization_code`, { method: "POST" })
			var tokenData = await tokenResponse.json()
			if(tokenData.error) throw tokenData.error || tokenData.error_description
			else authToken = tokenData?.access_token
		} catch(err){
			throw { statusCode: 500, error: "Erreur lors de l'authentification", message: `Google a retourné une erreur : ${(err.message || err).toString()}` }
		}
		if(!authToken) throw { statusCode: 500, error: "Erreur lors de l'authentification", message: "Google n'a pas retourné de token" }

		// Obtenir les informations de l'utilisateur
		var userData
		try {
			var userResponse = await fetch(`https://www.googleapis.com/oauth2/v1/userinfo?access_token=${authToken}`)
			userData = await userResponse.json()
			if(userData.error) throw userData.error || userData.error_description
		} catch(err){
			throw { statusCode: 500, error: "Erreur lors de l'authentification", message: `Google a retourné une erreur : ${(err.message || err).toString()}` }
		}
		if(!userData || !userData?.id) throw { statusCode: 500, error: "Erreur lors de l'authentification", message: "Google n'a pas retourné de données utilisateur, ou elles sont incomplètes" }

		// Vérifier si on a déjà un utilisateur avec cet ID
		var userToken
		var user = await supabase.from("stendglobal-accounts").select("*").eq("id", `google/${userData.id}`)
		if(user.error) throw { statusCode: 500, error: "Erreur lors de l'authentification", message: `Supabase a retourné une erreur (pendant : vérif. compte existe) : ${user.error.message}` }
		if(!user.data.length){ // Créer un nouvel utilisateur
			userToken = generateRandomString(64, true)
			while((await supabase.from("stendglobal-accounts").select("*").eq("token", userToken)).data.length) userToken = generateRandomString(64, true)
			var newUser = await supabase.from("stendglobal-accounts").insert({ id: `google/${userData.id}`, token: userToken })
			if(newUser.error) throw { statusCode: 500, error: "Erreur lors de l'authentification", message: `Supabase a retourné une erreur (pendant : création du compte) : ${newUser.error.message}` }
		}

		// Générer un code temporaire qui permettra à l'utilisateur d'obtenir son token
		var tempCode = generateRandomString(8)
		while((await supabase.from("stendglobal-accounts").select("*").eq("authCode", tempCode)).data.length) tempCode = generateRandomString(8)
		var tempCodeData = await supabase.from("stendglobal-accounts").update({ authCode: tempCode, authCodeExpires: new Date().getTime() + 1000 * 60 * 30 }).match({ id: `google/${userData.id}` })
		if(tempCodeData.error) throw { statusCode: 500, error: "Erreur lors de l'authentification", message: `Supabase a retourné une erreur (pendant : création du code temporaire) : ${tempCodeData.error.message}` }

		// Envoyer la réponse
		if(responseType === "redirect") return res.redirect(`stend://globalserver/auth?code=${tempCode}`)
		else if(responseType === "html") return res.header("Content-Type", "text/html").send(`<html lang="fr"><head><title>Authentification à Stend</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"/><style>body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8f9fa; color: #000; margin: 0; width: 100vw; height: 100vh; display: grid; place-items: center; text-align: center; } .code { display: flex; place-items: center; justify-content: center; } .code h3 { font-size: 2em; font-weight: bold; padding: 18px 64px 18px 64px; border-radius: 12px; color: #007bff; background-color: #202020; box-shadow: 0 0 12px rgba(0, 0, 0, 0.6); letter-spacing: 0.1em; }</style></head><body><div style="padding: 12px 12px 12px 12px;"><h1>Authentification à Stend</h1><p>Pour finaliser la connexion, revenez dans l'application et entrez le code suivant :</p><div class="code"><h3 onclick="window.getSelection().selectAllChildren(this);">${tempCode}</h3></div></div></body></html>`)
		else return res.header("Content-Type", "text/plain").send(tempCode)
	})

	fastify.get("/auth/checkcode", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
		// Obtenir et vérifier le code
		var authCode = req.query.code
		if(!authCode) throw { statusCode: 400, error: "Paramètres manquants", message: "Le code est manquant" }

		// Obtenir un utilisateur avec ce code
		var user = await supabase.from("stendglobal-accounts").select("*").eq("authCode", authCode)
		if(user.error) throw { statusCode: 500, error: "Erreur lors de la vérification", message: `Supabase a retourné une erreur : ${user.error.message}` }
		if(!user.data.length) throw { statusCode: 404, error: "Code invalide", message: "Ce code n'existe pas, il a peut-être expiré ou été remplacé" }
		user = user.data[0]

		// Vérifier si le code a expiré
		if(user.authCodeExpires < new Date().getTime()){
			try { await supabase.from("stendglobal-accounts").update({ authCode: null, authCodeExpires: null }).match({ id: user.id }) } catch(err){} // on tente de supprimer le code si possible
			throw { statusCode: 400, error: "Code expiré", message: "Ce code a expiré, veuillez vous reconnecter" }
		}

		// Supprimer le code
		var deleteCode = await supabase.from("stendglobal-accounts").update({ authCode: null, authCodeExpires: null }).match({ id: user.id })
		if(deleteCode.error) throw { statusCode: 500, error: "Erreur lors de la vérification", message: `Supabase a retourné une erreur : ${deleteCode.error.message}` }

		// Envoyer le token
		return { success: true, token: user.token, action: "SAVE_TOKEN" }
	})

	// Routes liés à la gestion du compte
	fastify.get("/account/transferts", { config: { rateLimit: { max: 100, timeWindow: "1 minute" } } }, async (req) => { // retourne uniquement les transferts créés en étant authentifié
		// Obtenir l'utilisateur
		var user = await getUserFromRequest(req)

		// Obtenir les transferts
		var transferts = await supabase.from("stendglobal-transfers").select("*").eq("authorId", user.id)
		if(transferts.error) throw { statusCode: 500, error: "Erreur lors de l'obtention des transferts", message: `Supabase a retourné une erreur : ${transferts.error.message}` }

		// Filtrer les transferts expirés
		transferts = transferts.data.filter(transfer => parseInt(transfer.expiresDate) > new Date().getTime())

		// Retourner les transferts
		return { success: true, transferts: transferts?.map(transfer => { return { id: transfer.transferId, webUrl: transfer.webUrl, expiresDate: transfer.expiresDate, nickname: transfer.nickname, fileName: transfer.fileName } }) || [] }
	})
	fastify.post("/account/reset", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
		// Obtenir le token actuel et vérifier qu'il est valide
		var token = req.headers.authorization
		await getUserFromRequest(req) // retourne une erreur si le token est invalide

		// Générer un nouveau token
		var newToken = generateRandomString(64, true)
		while((await supabase.from("stendglobal-accounts").select("*").eq("token", newToken)).data.length) newToken = generateRandomString(64, true)

		// Ajouter le nouveau token
		var changeToken = await supabase.from("stendglobal-accounts").update({ token: newToken }).eq("token", token)
		if(changeToken.error) throw { statusCode: 500, error: "Erreur lors de la réinitialisation du token", message: `Supabase a retourné une erreur : ${changeToken.error.message}` }

		// Envoyer le nouveau token
		return { success: true, token: newToken, action: "SAVE_TOKEN" }
	})
	fastify.post("/account/delete", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
		// Obtenir le token actuel et vérifier qu'il est valide
		var token = req.headers.authorization
		await getUserFromRequest(req) // retourne une erreur si le token est invalide

		// Supprimer l'utilisateur
		var deleteUser = await supabase.from("stendglobal-accounts").delete().eq("token", token)
		if(deleteUser.error) throw { statusCode: 500, error: "Erreur lors de la suppression du compte", message: `Supabase a retourné une erreur : ${deleteUser.error.message}` }

		// Envoyer la confirmation
		return { success: true, action: "DELETE_TOKEN" }
	})

	// Routes liés à la gestion des transferts
	fastify.post("/transferts/create", { config: { rateLimit: { max: 150, timeWindow: "1 minute" } } }, async (req) => {
		// Déterminer les méthodes à utiliser (google, ip+instance, localisation)
		var webUrl, apiUrl, latitude, longitude, expiresTime, authorIp, nickname, fileName
		var authToken = req.headers.authorization
		try { fileName = JSON.parse(req.body).fileName || req.body?.fileName } catch(e) { fileName = req.body?.fileName }
		try { webUrl = JSON.parse(req.body).webUrl || req.body?.webUrl } catch(e) { webUrl = req.body?.webUrl }
		try { apiUrl = JSON.parse(req.body).apiUrl || req.body?.apiUrl } catch(e) { apiUrl = req.body?.apiUrl }
		try { latitude = JSON.parse(req.body).latitude || req.body?.latitude } catch(e) { latitude = req.body?.latitude }
		try { longitude = JSON.parse(req.body).longitude || req.body?.longitude } catch(e) { longitude = req.body?.longitude }
		try { expiresTime = JSON.parse(req.body).expiresTime || req.body?.expiresTime } catch(e) { expiresTime = req.body?.expiresTime } // en minutes
		try { nickname = JSON.parse(req.body).nickname || req.body?.nickname } catch(e) { nickname = req.body?.nickname }

		// Vérifier les types
		if(typeof fileName != "string") throw { statusCode: 400, error: "Paramètres invalides", message: "Le nom du fichier doit être une chaîne de caractères" }
		if(typeof nickname != "string") throw { statusCode: 400, error: "Paramètres invalides", message: "Le surnom doit être une chaîne de caractères" }
		if(typeof webUrl != "string") throw { statusCode: 400, error: "Paramètres invalides", message: "L'URL du transfert doit être une chaîne de caractères" }
		if(apiUrl && typeof apiUrl != "string") throw { statusCode: 400, error: "Paramètres invalides", message: "L'URL de l'API doit être une chaîne de caractères" }
		if(latitude){
			if(typeof latitude == "string") latitude = parseFloat(latitude)
			if(typeof latitude != "number") throw { statusCode: 400, error: "Paramètres invalides", message: "La latitude doit être un nombre" }
		}
		if(longitude){
			if(typeof longitude == "string") longitude = parseFloat(longitude)
			if(typeof longitude != "number") throw { statusCode: 400, error: "Paramètres invalides", message: "La longitude doit être un nombre" }
		}
		if(expiresTime){
			if(typeof expiresTime == "string") expiresTime = parseInt(expiresTime)
			if(typeof expiresTime != "number") throw { statusCode: 400, error: "Paramètres invalides", message: "La durée d'expiration doit être un nombre" }
		}

		// Vérifier les paramètres
		if(!webUrl) throw { statusCode: 400, error: "Paramètres manquants", message: "L'URL du transfert est manquante" }
		if(!fileName) throw { statusCode: 400, error: "Paramètres manquants", message: "Le nom du fichier est manquant" }
		if(webUrl){
			try { new URL(webUrl) } catch(err){ throw { statusCode: 400, error: "Paramètres invalides", message: "L'URL fournie n'est pas valide" } }
			if(webUrl.endsWith("/")) webUrl = webUrl.slice(0, -1)
		}
		if(apiUrl){
			try { new URL(apiUrl) } catch(err){ throw { statusCode: 400, error: "Paramètres invalides", message: "L'URL fournie n'est pas valide" } }
			apiUrl = new URL(apiUrl).hostname // on ne garde que le domaine
			if(apiUrl.endsWith("/")) apiUrl = apiUrl.slice(0, -1)
			authorIp = req.ip
		}
		if(latitude && longitude){
			if(latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw { statusCode: 400, error: "Paramètres invalides", message: "Les coordonnées fournies sont invalides" }
			if(distanceGPS(latitude, longitude, 0, 0) > 15000) throw { statusCode: 400, error: "Paramètres invalides", message: "Les coordonnées fournies sont trop éloignées du centre du monde" }
		} else if(latitude || longitude){
			throw { statusCode: 400, error: "Paramètres invalides", message: "Les coordonnées fournies sont incomplètes" }
		}

		// Censurer le surnom
		nickname = nickname.replace(/[^a-zA-Z0-9\sÀ-ÿ']/g, "") // enlever les caractères spéciaux, sauf les accents, les apostrophes et les espaces
		if(nickname.length > 18) nickname = `${nickname.substring(0, 18)}...` // max 18 caractères
		nickname = nickname.trim() // trim
		if(nickname.length < 3) nickname = "Anonyme" // nom par défaut si on en a pas
		else nickname = removeProfanity(nickname) // censurer les insultes

		// Censurer le nom du fichier
		fileName = fileName.replace(/[\r\n\s]/g, "_").replace(/[^a-zA-Z0-9À-ÿ._-]/g, "") // enlever les caractères spéciaux (hors accents, points, tirets (du bas)) et remplacer les espaces par des tirets du bas
		if(fileName.length > 32) fileName = `${fileName.substring(0, 32)}...`
		fileName = fileName.trim()
		if(fileName.length < 2) fileName = "Sans nom"
		else fileName = removeProfanity(fileName)

		// Définir une limite à la durée d'expiration (max. 1 heure)
		if(!expiresTime || expiresTime > 60 || expiresTime < 1) expiresTime = 60

		// Si on a un token, on vérifie que le compte est valide
		var user
		if(authToken) user = await getUserFromRequest(req)

		// Vérifier qu'on a au minimum une méthode d'exposition
		if(!apiUrl && (!latitude && !longitude) && !user?.id) throw { statusCode: 400, error: "Paramètres manquants", message: "Vous devez fournir au moins une méthode d'exposition" }

		// Créer un transfert
		var transferId = generateRandomString(16, true)
		while((await supabase.from("stendglobal-transfers").select("*").eq("transferId", transferId)).data.length) transferId = generateRandomString(16, true)
		var newTransfer = await supabase.from("stendglobal-transfers").insert({ transferId, authorId: user?.id || null, webUrl, expiresDate: new Date().getTime() + 1000 * 60 * expiresTime, apiUrl, authorIp, latitude, longitude, nickname, fileName })
		if(newTransfer.error) throw { statusCode: 500, error: "Erreur lors de la création du transfert", message: `Supabase a retourné une erreur : ${newTransfer.error.message}` }

		// Retourner le transfert
		return { success: true, transferId, nickname, fileName, method: { instanceAndIp: !!apiUrl, location: !!latitude && !!longitude, account: !!user?.id } }
	})
	fastify.post("/transferts/list", { config: { rateLimit: { max: 10, timeWindow: "30 seconds" } } }, async (req) => {
		// Déterminer les méthodes à utiliser (google, ip+instance, localisation)
		var apiUrl, latitude, longitude, authorIp
		var authToken = req.headers.authorization
		try { apiUrl = JSON.parse(req.body).apiUrl || req.body?.apiUrl } catch(e) { apiUrl = req.body?.apiUrl }
		try { latitude = JSON.parse(req.body).latitude || req.body?.latitude } catch(e) { latitude = req.body?.latitude }
		try { longitude = JSON.parse(req.body).longitude || req.body?.longitude } catch(e) { longitude = req.body?.longitude }

		// Vérifier les types
		if(apiUrl && typeof apiUrl != "string") throw { statusCode: 400, error: "Paramètres invalides", message: "L'URL de l'API doit être une chaîne de caractères" }
		if(latitude){
			if(typeof latitude == "string") latitude = parseFloat(latitude)
			if(typeof latitude != "number") throw { statusCode: 400, error: "Paramètres invalides", message: "La latitude doit être un nombre" }
		}
		if(longitude){
			if(typeof longitude == "string") longitude = parseFloat(longitude)
			if(typeof longitude != "number") throw { statusCode: 400, error: "Paramètres invalides", message: "La longitude doit être un nombre" }
		}

		// Vérifier les paramètres
		if(apiUrl){
			try { new URL(apiUrl) } catch(err){ throw { statusCode: 400, error: "Paramètres invalides", message: "L'URL fournie n'est pas valide" } }
			apiUrl = new URL(apiUrl).hostname // on ne garde que le domaine
			if(apiUrl.endsWith("/")) apiUrl = apiUrl.slice(0, -1)
			authorIp = req.ip
		}
		if(latitude && longitude){
			if(latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw { statusCode: 400, error: "Paramètres invalides", message: "Les coordonnées fournies sont invalides" }
			if(distanceGPS(latitude, longitude, 0, 0) > 15000) throw { statusCode: 400, error: "Paramètres invalides", message: "Les coordonnées fournies sont trop éloignées du centre du monde" }
		} else if(latitude || longitude){
			throw { statusCode: 400, error: "Paramètres invalides", message: "Les coordonnées fournies sont incomplètes" }
		}

		// Si on a un token, on vérifie que le compte est valide
		var user
		if(authToken) user = await getUserFromRequest(req)

		// Vérifier qu'on a au minimum une méthode d'exposition
		if(!apiUrl && (!latitude && !longitude) && !user?.id) throw { statusCode: 400, error: "Paramètres manquants", message: "Vous devez fournir au moins une méthode d'exposition" }

		// Obtenir tous les transferts
		var transfers = await supabase.from("stendglobal-transfers").select("*")
		if(transfers.error) throw { statusCode: 500, error: "Erreur lors de l'obtention des transferts", message: `Supabase a retourné une erreur : ${transfers.error.message}` }

		// Chercher des transferts qui correspondent aux paramètres de l'utilisateur
		transfers = transfers.data.filter(transfer => {
			if(transfer.expiresDate < new Date().getTime()) return false // éviter les transfert expiré

			if(user?.id && transfer.authorId === user.id) return true // garder les transfert créé par l'utilisateur
			if(apiUrl && authorIp && transfer.apiUrl === apiUrl && transfer.authorIp === authorIp) return true // transfert sur la même instance avec la même IP
			if(latitude && longitude && transfer.latitude && transfer.longitude && distanceGPS(latitude, longitude, transfer.latitude, transfer.longitude) < 2) return true // transfert à moins de 2km // TODO: on vérifiera si cette distance est correcte avec des tests irl quand ça sera intégrée

			return false
		})
		if(transfers.length > 100) transfers = transfers.slice(0, 100) // max 100 transferts

		// Retourner les transferts
		return {
			success: true,
			transferts: transfers?.map(transfer => { return { id: transfer.transferId, webUrl: transfer.webUrl, expiresDate: transfer.expiresDate, nickname: transfer.nickname, fileName: transfer.fileName } }) || [],
			method: { instanceAndIp: !!apiUrl, location: !!latitude && !!longitude, account: !!user?.id }
		}
	})
}

// Démarrer le serveur
async function main(){
	// Register qlqs plugins
	await fastify.register(require("@fastify/cors"))
	await fastify.register(require("@fastify/rate-limit"), { global: true, max: 1000, timeWindow: "10 minute" })

	// Créer les routes
	createRoutes()

	// Démarrer le serveur
	fastify.listen({ port: process.env.PORT || 3000, host: "0.0.0.0" }, (err) => {
		if(err){
			fastify.log.error(err)
			process.exit(1)
		}

		console.log(`Server listening on port ${fastify.server.address().port}`)
	})

	// Supprimer les transferts expirés
	await deleteExpiredTransfers()
	setInterval(deleteExpiredTransfers, 1000 * 60 * 60 * 12) // toutes les 12h
}
main()