/*
       Licensed to the Apache Software Foundation (ASF) under one
       or more contributor license agreements.  See the NOTICE file
       distributed with this work for additional information
       regarding copyright ownership.  The ASF licenses this file
       to you under the Apache License, Version 2.0 (the
       "License"); you may not use this file except in compliance
       with the License.  You may obtain a copy of the License at

         http://www.apache.org/licenses/LICENSE-2.0

       Unless required by applicable law or agreed to in writing,
       software distributed under the License is distributed on an
       "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
       KIND, either express or implied.  See the License for the
       specific language governing permissions and limitations
       under the License.
*/

var Q = require('q');
var fs = require('fs');
var util = require('util');
var path = require('path');
var shell = require('shelljs');
var superspawn = require('cordova-common').superspawn;
var CordovaError = require('cordova-common').CordovaError;
var check_reqs = require('../check_reqs');

var GenericBuilder = require('./GenericBuilder');

var MARKER = 'YOUR CHANGES WILL BE ERASED!';
var SIGNING_PROPERTIES = '-signing.properties';
var TEMPLATE =
    '# This file is automatically generated.\n' +
    '# Do not modify this file -- ' + MARKER + '\n';

function GradleBuilder (projectRoot) {
    GenericBuilder.call(this, projectRoot);

    this.binDirs = { gradle: this.binDirs.gradle };
}

util.inherits(GradleBuilder, GenericBuilder);

GradleBuilder.prototype.getArgs = function (cmd, opts) {
    if (cmd === 'release') {
        cmd = 'cdvBuildRelease';
    } else if (cmd === 'debug') {
        cmd = 'cdvBuildDebug';
    }
    var args = [cmd, '-b', path.join(this.root, 'build.gradle')];
    if (opts.arch) {
        args.push('-PcdvBuildArch=' + opts.arch);
    }

    // 10 seconds -> 6 seconds
    args.push('-Dorg.gradle.daemon=true');
    // to allow dex in process
    args.push('-Dorg.gradle.jvmargs=-Xmx2048m');
    // allow NDK to be used - required by Gradle 1.5 plugin
    args.push('-Pandroid.useDeprecatedNdk=true');
    args.push.apply(args, opts.extraArgs);
    // Shaves another 100ms, but produces a "try at own risk" warning. Not worth it (yet):
    // args.push('-Dorg.gradle.parallel=true');
    return args;
};

/*
 * This returns a promise
 */

GradleBuilder.prototype.runGradleWrapper = function (gradle_cmd, gradle_file) {
    var gradlePath = path.join(this.root, 'gradlew');
    gradle_file = path.join(this.root, (gradle_file || 'wrapper.gradle'));
    if (fs.existsSync(gradlePath)) {
        // Literally do nothing, for some reason this works, while !fs.existsSync didn't on Windows
    } else {
        return superspawn.spawn(gradle_cmd, ['-p', this.root, 'wrapper', '-b', gradle_file], { stdio: 'pipe' })
            .progress(function (stdio) {
                suppressJavaOptionsInfo(stdio);
            });
    }
};

/*
 * We need to kill this in a fire.
 */

GradleBuilder.prototype.readProjectProperties = function () {
    function findAllUniq (data, r) {
        var s = {};
        var m;
        while ((m = r.exec(data))) {
            s[m[1]] = 1;
        }
        return Object.keys(s);
    }

    var data = fs.readFileSync(path.join(this.root, 'project.properties'), 'utf8');
    return {
        libs: findAllUniq(data, /^\s*android\.library\.reference\.\d+=(.*)(?:\s|$)/mg),
        gradleIncludes: findAllUniq(data, /^\s*cordova\.gradle\.include\.\d+=(.*)(?:\s|$)/mg),
        systemLibs: findAllUniq(data, /^\s*cordova\.system\.library\.\d+=(.*)(?:\s|$)/mg)
    };
};

GradleBuilder.prototype.extractRealProjectNameFromManifest = function () {
    var manifestPath = path.join(this.root, 'AndroidManifest.xml');
    var manifestData = fs.readFileSync(manifestPath, 'utf8');
    var m = /<manifest[\s\S]*?package\s*=\s*"(.*?)"/i.exec(manifestData);
    if (!m) {
        throw new CordovaError('Could not find package name in ' + manifestPath);
    }

    var packageName = m[1];
    var lastDotIndex = packageName.lastIndexOf('.');
    return packageName.substring(lastDotIndex + 1);
};

// Makes the project buildable, minus the gradle wrapper.
GradleBuilder.prototype.prepBuildFiles = function () {
    // Update the version of build.gradle in each dependent library.
    var pluginBuildGradle = path.join(this.root, 'cordova', 'lib', 'plugin-build.gradle');
    var propertiesObj = this.readProjectProperties();
    var subProjects = propertiesObj.libs;

    // Check and copy the gradle file into the subproject.
    // Called by the loop below this function def.
    var checkAndCopy = function (subProject, root) {
        var subProjectGradle = path.join(root, subProject, 'build.gradle');
        // This is the future-proof way of checking if a file exists
        // This must be synchronous to satisfy a Travis test
        try {
            fs.accessSync(subProjectGradle, fs.F_OK);
        } catch (e) {
            shell.cp('-f', pluginBuildGradle, subProjectGradle);
        }
    };

    // Some dependencies on Android don't use gradle, or don't have default
    // gradle files.  This copies a dummy gradle file into them
    for (var i = 0; i < subProjects.length; ++i) {
        if (subProjects[i] !== 'CordovaLib' && subProjects[i] !== 'app') {
            checkAndCopy(subProjects[i], this.root);
        }
    }

    var name = this.extractRealProjectNameFromManifest();
    // Remove the proj.id/name- prefix from projects: https://issues.apache.org/jira/browse/CB-9149
    var settingsGradlePaths = subProjects.map(function (p) {
        var realDir = p.replace(/[/\\]/g, ':');
        var libName = realDir.replace(name + '-', '');
        var str = 'include ":' + libName + '"\n';
        if (realDir.indexOf(name + '-') !== -1) { str += 'project(":' + libName + '").projectDir = new File("' + p + '")\n'; }
        return str;
    });

    // Write the settings.gradle file.
    fs.writeFileSync(path.join(this.root, 'settings.gradle'),
        '// GENERATED FILE - DO NOT EDIT\n' +
        'include ":"\n' + settingsGradlePaths.join(''));
    // Update dependencies within build.gradle.
    var buildGradle = fs.readFileSync(path.join(this.root, 'build.gradle'), 'utf8');
    var depsList = '';
    var root = this.root;

    // Cordova Plugins can be written as library modules that would use Cordova as a
    // dependency.  Because we need to make sure that Cordova is compiled only once for
    // dexing, we make sure to exclude CordovaLib from these modules
    var insertExclude = function (p) {
        var gradlePath = path.join(root, p, 'build.gradle');
        var projectGradleFile = fs.readFileSync(gradlePath, 'utf-8');
        if (projectGradleFile.indexOf('CordovaLib') !== -1) {
            depsList += '{\n        exclude module:("CordovaLib")\n    }\n';
        } else {
            depsList += '\n';
        }
    };

    subProjects.forEach(function (p) {
        console.log('Subproject Path: ' + p);
        var libName = p.replace(/[/\\]/g, ':').replace(name + '-', '');
        depsList += '    implementation(project(path: "' + libName + '"))';
        insertExclude(p);
    });

    // For why we do this mapping: https://issues.apache.org/jira/browse/CB-8390
    var SYSTEM_LIBRARY_MAPPINGS = [
        [/^\/?extras\/android\/support\/(.*)$/, 'com.android.support:support-$1:+'],
        [/^\/?google\/google_play_services\/libproject\/google-play-services_lib\/?$/, 'com.google.android.gms:play-services:+']
    ];
    propertiesObj.systemLibs.forEach(function (p) {
        var mavenRef;
        // It's already in gradle form if it has two ':'s
        if (/:.*:/.exec(p)) {
            mavenRef = p;
        } else {
            for (var i = 0; i < SYSTEM_LIBRARY_MAPPINGS.length; ++i) {
                var pair = SYSTEM_LIBRARY_MAPPINGS[i];
                if (pair[0].exec(p)) {
                    mavenRef = p.replace(pair[0], pair[1]);
                    break;
                }
            }
            if (!mavenRef) {
                throw new CordovaError('Unsupported system library (does not work with gradle): ' + p);
            }
        }
        depsList += '    compile "' + mavenRef + '"\n';
    });

    // This code is dangerous and actually writes gradle declarations directly into the build.gradle
    // Try not to mess with this if possible
    buildGradle = buildGradle.replace(/(SUB-PROJECT DEPENDENCIES START)[\s\S]*(\/\/ SUB-PROJECT DEPENDENCIES END)/, '$1\n' + depsList + '    $2');
    var includeList = '';
    propertiesObj.gradleIncludes.forEach(function (includePath) {
        includeList += 'apply from: "' + includePath + '"\n';
    });
    buildGradle = buildGradle.replace(/(PLUGIN GRADLE EXTENSIONS START)[\s\S]*(\/\/ PLUGIN GRADLE EXTENSIONS END)/, '$1\n' + includeList + '$2');
    fs.writeFileSync(path.join(this.root, 'build.gradle'), buildGradle);
};

GradleBuilder.prototype.prepEnv = function (opts) {
    var self = this;
    return check_reqs.check_gradle().then(function (gradlePath) {
        return self.runGradleWrapper(gradlePath);
    }).then(function () {
        return self.prepBuildFiles();
    }).then(function () {
        // We now copy the gradle out of the framework
        // This is a dirty patch to get the build working
        /*
        var wrapperDir = path.join(self.root, 'CordovaLib');
        if (process.platform == 'win32') {
            shell.rm('-f', path.join(self.root, 'gradlew.bat'));
            shell.cp(path.join(wrapperDir, 'gradlew.bat'), self.root);
        } else {
            shell.rm('-f', path.join(self.root, 'gradlew'));
            shell.cp(path.join(wrapperDir, 'gradlew'), self.root);
        }
        shell.rm('-rf', path.join(self.root, 'gradle', 'wrapper'));
        shell.mkdir('-p', path.join(self.root, 'gradle'));
        shell.cp('-r', path.join(wrapperDir, 'gradle', 'wrapper'), path.join(self.root, 'gradle'));
*/
        // If the gradle distribution URL is set, make sure it points to version we want.
        // If it's not set, do nothing, assuming that we're using a future version of gradle that we don't want to mess with.
        // For some reason, using ^ and $ don't work.  This does the job, though.
        var distributionUrlRegex = /distributionUrl.*zip/;
        /* jshint -W069 */
        var distributionUrl = process.env['CORDOVA_ANDROID_GRADLE_DISTRIBUTION_URL'] || 'https\\://services.gradle.org/distributions/gradle-5.1.1-all.zip';
        /* jshint +W069 */
        var gradleWrapperPropertiesPath = path.join(self.root, 'gradle', 'wrapper', 'gradle-wrapper.properties');
        shell.chmod('u+w', gradleWrapperPropertiesPath);
        shell.sed('-i', distributionUrlRegex, 'distributionUrl=' + distributionUrl, gradleWrapperPropertiesPath);

        var propertiesFile = opts.buildType + SIGNING_PROPERTIES;
        var propertiesFilePath = path.join(self.root, propertiesFile);
        if (opts.packageInfo) {
            fs.writeFileSync(propertiesFilePath, TEMPLATE + opts.packageInfo.toProperties());
        } else if (isAutoGenerated(propertiesFilePath)) {
            shell.rm('-f', propertiesFilePath);
        }
    });
};

/*
 * Builds the project with gradle.
 * Returns a promise.
 */
GradleBuilder.prototype.build = function (opts) {
    var wrapper = path.join(this.root, 'gradlew');
    var args = this.getArgs(opts.buildType === 'debug' ? 'debug' : 'release', opts);

    return superspawn.spawn(wrapper, args, { stdio: 'pipe' })
        .progress(function (stdio) {
            suppressJavaOptionsInfo(stdio);
        }).catch(function (error) {
            if (error.toString().indexOf('failed to find target with hash string') >= 0) {
                return check_reqs.check_android_target(error).then(function () {
                    // If due to some odd reason - check_android_target succeeds
                    // we should still fail here.
                    return Q.reject(error);
                });
            }
            return Q.reject(error);
        });
};

GradleBuilder.prototype.clean = function (opts) {
    var builder = this;
    var wrapper = path.join(this.root, 'gradlew');
    var args = builder.getArgs('clean', opts);
    return Q().then(function () {
        return superspawn.spawn(wrapper, args, { stdio: 'inherit' });
    }).then(function () {
        shell.rm('-rf', path.join(builder.root, 'out'));

        ['debug', 'release'].forEach(function (config) {
            var propertiesFilePath = path.join(builder.root, config + SIGNING_PROPERTIES);
            if (isAutoGenerated(propertiesFilePath)) {
                shell.rm('-f', propertiesFilePath);
            }
        });
    });
};

module.exports = GradleBuilder;

function suppressJavaOptionsInfo (stdio) {
    if (stdio.stderr) {
        /*
         * Workaround for the issue with Java printing some unwanted information to
         * stderr instead of stdout.
         * This function suppresses 'Picked up _JAVA_OPTIONS' message from being
         * printed to stderr. See https://issues.apache.org/jira/browse/CB-9971 for
         * explanation.
         */
        var suppressThisLine = /^Picked up _JAVA_OPTIONS: /i.test(stdio.stderr.toString());
        if (suppressThisLine) {
            return;
        }
        process.stderr.write(stdio.stderr);
    } else {
        process.stdout.write(stdio.stdout);
    }
}

function isAutoGenerated (file) {
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').indexOf(MARKER) > 0;
}
