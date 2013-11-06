const PR_RDWR = 0x04;
const PR_CREATE_FILE = 0x08;
const PR_TRUNCATE = 0x20;

Components.utils.import("resource://gre/modules/FileUtils.jsm");
Components.utils.import("resource://gre/modules/PageThumbs.jsm");
Components.utils.import("resource://gre/modules/Promise.jsm");

function exportShowOptionDialog() {
	let deferred = Promise.defer();

	let returnValues = {
		cancelled: true
	};
	let done = function() {
		if (returnValues.cancelled) {
			deferred.reject();
		} else {
			deferred.resolve(returnValues);
		}
	};

	let dialog = window.openDialog("chrome://newtabtools/content/exportDialog.xul", "newtabtools-export", "centerscreen", returnValues, done);
	return deferred.promise;
}

function exportShowFilePicker(aReturnValues) {
	let deferred = Promise.defer();

	let picker = Components.classes["@mozilla.org/filepicker;1"].createInstance(Components.interfaces.nsIFilePicker);
	picker.init(window, "title", Components.interfaces.nsIFilePicker.modeSave);
	picker.appendFilter("Zip Archive", "*.zip");
	picker.defaultExtension = "zip";
	picker.defaultString = "newtabtools.zip";
	picker.open(function(aResult) {
		if (aResult == Components.interfaces.nsIFilePicker.returnCancel) {
			deferred.reject();
		} else {
			aReturnValues.file = picker.file;
			deferred.resolve(aReturnValues);
		}
	});

	return deferred.promise;
}

function exportSave(aReturnValues) {
	let zipWriter = Components.classes["@mozilla.org/zipwriter;1"].createInstance(Components.interfaces.nsIZipWriter);
	zipWriter.open(aReturnValues.file, PR_RDWR | PR_CREATE_FILE | PR_TRUNCATE);

	{
		let annoService = Components.classes["@mozilla.org/browser/annotation-service;1"].getService(Components.interfaces.nsIAnnotationService);
		let annos = [
			"newtabtools/title"
		];
		let pages = {};
		for (let a of annos) {
			pages[a] = {};
			for (let p of annoService.getPagesWithAnnotation(a)) {
					pages[a][p.spec] = annoService.getPageAnnotation(p, a);
			}
		}

		let stream = Components.classes["@mozilla.org/io/string-input-stream;1"].createInstance(Components.interfaces.nsIStringInputStream);
		let data = JSON.stringify(pages);
		stream.setData(data, data.length);
		zipWriter.addEntryStream("annos.json", Date.now() * 1000, Components.interfaces.nsIZipWriter.COMPRESSION_DEFAULT, stream, false);
	}
	{
		let keys = [
			"browser.newtabpage.blocked",
			"browser.newtabpage.columns",
			"browser.newtabpage.pinned",
			"browser.newtabpage.rows",
			"extensions.newtabtools.launcher",
			"extensions.newtabtools.launcher.dark",
			"extensions.newtabtools.recent.show",
			"extensions.newtabtools.thumbs.contain",
			"extensions.newtabtools.thumbs.hidebuttons",
			"extensions.newtabtools.thumbs.hidefavicons"
		];
		let prefs = {};
		for (let k of keys) {
			switch (Services.prefs.getPrefType(k)) {
			case Components.interfaces.nsIPrefBranch.PREF_STRING:
				prefs[k] = Services.prefs.getCharPref(k);
				break;
			case Components.interfaces.nsIPrefBranch.PREF_INT:
				prefs[k] = Services.prefs.getIntPref(k);
				break;
			case Components.interfaces.nsIPrefBranch.PREF_BOOL:
				prefs[k] = Services.prefs.getBoolPref(k);
				break;
			}
		}

		let stream = Components.classes["@mozilla.org/io/string-input-stream;1"].createInstance(Components.interfaces.nsIStringInputStream);
		let data = JSON.stringify(prefs);
		stream.setData(data, data.length);
		zipWriter.addEntryStream("prefs.json", Date.now() * 1000, Components.interfaces.nsIZipWriter.COMPRESSION_DEFAULT, stream, false);
	}
	{
		zipWriter.addEntryDirectory("thumbnails/", Date.now() * 1000, false);

		for (let l of NewTabUtils.links.getLinks().slice(0, Math.floor(gGrid.cells.length * 1.5))) {
			let f = new FileUtils.File(PageThumbsStorage.getFilePathForURL(l.url));
			if (f.exists() && !f.isWritable()) {
				if (zipWriter.hasEntry("thumbnails/" + f.leafName)) {
					zipWriter.removeEntry("thumbnails/" + f.leafName, false);
				}
				zipWriter.addEntryFile("thumbnails/" + f.leafName, Components.interfaces.nsIZipWriter.COMPRESSION_DEFAULT, f, false);
			}
		}
	}
	{
		let backgroundFile = FileUtils.getFile("ProfD", ["newtab-background"]);
		zipWriter.addEntryFile("newtab-background", Components.interfaces.nsIZipWriter.COMPRESSION_DEFAULT, backgroundFile, false);
	}

	zipWriter.close();
}

function exportCancelled() {
	alert("export cancelled");
}

function doExport() {
	exportShowOptionDialog()
		.then(exportShowFilePicker)
		.then(exportSave, exportCancelled)
		.then(null, Components.utils.reportError);
}

function importShowFilePicker() {
	let deferred = Promise.defer();

	let picker = Components.classes["@mozilla.org/filepicker;1"].createInstance(Components.interfaces.nsIFilePicker);
	picker.init(window, "title", Components.interfaces.nsIFilePicker.modeOpen);
	picker.appendFilter("Zip Archive", "*.zip");
	picker.defaultExtension = "zip";
	picker.open(function(aResult) {
		if (aResult == Components.interfaces.nsIFilePicker.returnCancel) {
			deferred.reject();
		} else {
			deferred.resolve(picker.file);
		}
	});

	return deferred.promise;
}

function importLoad(aFile) {
	let deferred = Promise.defer();

	let returnValues = {
		cancelled: true,
		file: aFile
	};

	let zipReader = Components.classes["@mozilla.org/libjar/zip-reader;1"].createInstance(Components.interfaces.nsIZipReader);
	try {
		zipReader.open(aFile);

		{
			returnValues.annos = readZippedJSON(zipReader, "annos.json");
			returnValues.prefs = readZippedJSON(zipReader, "prefs.json");
		}
		{
			let thumbnails = [];
			let enumerator = zipReader.findEntries("thumbnails/*");
			while (enumerator.hasMore()) {
				let e = enumerator.getNext();
				if (e != "thumbnails/") {
					thumbnails.push(e);
				}
			}
			returnValues.thumbnails = thumbnails;
		}
		{
			returnValues.hasBackgroundImage = zipReader.hasEntry("newtab-background");
		}

	} finally {
		zipReader.close();
	}

	let done = function() {
		if (returnValues.cancelled) {
			deferred.reject();
		} else {
			deferred.resolve(returnValues);
		}
	};

	let dialog = window.openDialog("chrome://newtabtools/content/exportDialog.xul", "newtabtools-export", "centerscreen", returnValues, done);
	return deferred.promise;
}

function readZippedJSON(aZipReader, aFilePath) {
	if (aZipReader.hasEntry(aFilePath)) {
		let stream = aZipReader.getInputStream(aFilePath);
		let scriptableStream = Components.classes["@mozilla.org/scriptableinputstream;1"].createInstance(Components.interfaces.nsIScriptableInputStream);
		scriptableStream.init(stream);

		let data = scriptableStream.read(scriptableStream.available());
		return JSON.parse(data);
	}
	return {};
}

function importSave(aReturnValues) {
	let zipReader = Components.classes["@mozilla.org/libjar/zip-reader;1"].createInstance(Components.interfaces.nsIZipReader);
	try {
		zipReader.open(aReturnValues.file);

		{
			let annoService = Components.classes["@mozilla.org/browser/annotation-service;1"].getService(Components.interfaces.nsIAnnotationService);
			for (let [name, data] of Iterator(aReturnValues.annos)) {
				for (let [page, value] of Iterator(data)) {
					try {
						let uri = Services.io.newURI(page, null, null);
						annoService.setPageAnnotation(uri, name, value, 0, annoService.EXPIRE_WITH_HISTORY);
					} catch(e) {
						Components.utils.reportError(e);
					}
				}
			}
		}
		{
			for (let [name, value] of Iterator(aReturnValues.prefs)) {
				try {
					switch (typeof value) {
					case "string":
						Services.prefs.setCharPref(name, value);
						break;
					case "number":
						Services.prefs.setIntPref(name, value);
						break;
					case "boolean":
						Services.prefs.setBoolPref(name, value);
						break;
					}
				} catch(e) {
					Components.utils.reportError(e);
				}
			}
		}
		{
			let thumbsDirectory = new FileUtils.File(PageThumbsStorage.path);
			for (let file of aReturnValues.thumbnails) {
				let thumbFile = thumbsDirectory.clone();
				thumbFile.append(file.substring(11)); // length of "thumbnails/"
				zipReader.extract(file, thumbFile);
			}
		}
		if (aReturnValues.hasBackgroundImage) {
			zipReader.extract("newtab-background", FileUtils.getFile("ProfD", ["newtab-background"]));
		}
	} finally {
		zipReader.close();
	}
}

function importCancelled() {
	alert("import cancelled");
}

function doImport() {
	importShowFilePicker()
		.then(importLoad)
		.then(importSave, importCancelled)
		.then(null, Components.utils.reportError);
}