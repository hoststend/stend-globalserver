var fs = require('fs')
var path = require('path')
var profanities = []

// https://github.com/darwiin/french-badwords-list/blob/master/list.txt

module.exports = (string) => {
	if(!profanities.length) {
		profanities = fs.readFileSync(path.join(__dirname, 'profanities.txt')).toString().split('\n')
		profanities = profanities.map(profanity => profanity.trim().toLowerCase())
	}

	profanities.forEach(profanity => {
		string = string.replace(new RegExp(profanity, 'gi'), '*'.repeat(profanity.length))
	})

	return string
}